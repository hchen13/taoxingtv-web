// macOS only. Loaded into this project's emulator through its spawn environment.
// Scope outbound IP sockets to a physical interface; leave local ADB/Frida alone.
#include <sys/socket.h>
#include <netinet/in.h>
#include <net/if.h>
#include <mach-o/dyld.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

static int enabled;
static unsigned int interface_index;

__attribute__((constructor)) static void initialize(void) {
    const char *name = getenv("TXTV_DIRECT_INTERFACE");
    if (name == NULL || name[0] == '\0') return;
    char executable[4096];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0) return;
    const char *base = strrchr(executable, '/');
    base = base == NULL ? executable : base + 1;
    // The emulator launcher and helper children inherit the environment too.
    if (strncmp(base, "qemu-system-", 12) != 0) return;
    enabled = 1;
    interface_index = if_nametoindex(name);
}

static int bind_outbound(int fd, const struct sockaddr *address, socklen_t length) {
    if (!enabled || address == NULL || length < sizeof(struct sockaddr)) return 0;
    int level, option;
    if (address->sa_family == AF_INET && length >= sizeof(struct sockaddr_in)) {
        uint32_t ip = ntohl(((const struct sockaddr_in *)address)->sin_addr.s_addr);
        if ((ip >> 24) == 127 || ip == INADDR_ANY) return 0;
        level = IPPROTO_IP; option = IP_BOUND_IF;
    } else if (address->sa_family == AF_INET6 && length >= sizeof(struct sockaddr_in6)) {
        const struct in6_addr *ip = &((const struct sockaddr_in6 *)address)->sin6_addr;
        if (IN6_IS_ADDR_LOOPBACK(ip) || IN6_IS_ADDR_UNSPECIFIED(ip)) return 0;
        if (IN6_IS_ADDR_V4MAPPED(ip) && ip->s6_addr[12] == 127) return 0;
        level = IPPROTO_IPV6; option = IPV6_BOUND_IF;
    } else return 0;
    // A missing interface must fail visibly, never silently return to the TUN.
    if (interface_index == 0) { errno = ENODEV; return -1; }
    unsigned int current = 0;
    socklen_t size = sizeof(current);
    if (getsockopt(fd, level, option, &current, &size) < 0) return -1;
    // Avoid resetting the cached route on every UDP packet. Querying the socket
    // instead of caching fd numbers also handles close/reuse across threads.
    if (current == interface_index) return 0;
    return setsockopt(fd, level, option, &interface_index, sizeof(interface_index));
}

static int txtv_connect(int fd, const struct sockaddr *address, socklen_t length) {
    if (bind_outbound(fd, address, length) < 0) return -1;
    return connect(fd, address, length);
}

static int txtv_connectx(int fd, const sa_endpoints_t *endpoints, sae_associd_t assoc,
                         unsigned int flags, const struct iovec *iov, unsigned int count,
                         size_t *written, sae_connid_t *connection) {
    if (endpoints != NULL && bind_outbound(fd, endpoints->sae_dstaddr, endpoints->sae_dstaddrlen) < 0) return -1;
    return connectx(fd, endpoints, assoc, flags, iov, count, written, connection);
}

static ssize_t txtv_sendto(int fd, const void *buffer, size_t length, int flags,
                           const struct sockaddr *address, socklen_t address_length) {
    if (bind_outbound(fd, address, address_length) < 0) return -1;
    return sendto(fd, buffer, length, flags, address, address_length);
}

static ssize_t txtv_sendmsg(int fd, const struct msghdr *message, int flags) {
    if (message != NULL && bind_outbound(fd, message->msg_name, message->msg_namelen) < 0) return -1;
    return sendmsg(fd, message, flags);
}

// dyld calls made from this image still resolve to the original implementation.
#define INTERPOSE(replacement, original) \
    __attribute__((used)) static const struct { const void *replace; const void *with; } \
    interpose_##original __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)&replacement, (const void *)&original }
INTERPOSE(txtv_connect, connect);
INTERPOSE(txtv_connectx, connectx);
INTERPOSE(txtv_sendto, sendto);
INTERPOSE(txtv_sendmsg, sendmsg);
