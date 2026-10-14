#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "check failed line %d: %s (errno %d)\n", __LINE__, #expr, errno); return 1; } } while (0)
static unsigned int bound_interface(int fd) {
    unsigned int value=0; socklen_t size=sizeof(value);
    if (getsockopt(fd, IPPROTO_IP, IP_BOUND_IF, &value, &size)) return (unsigned int)-1;
    return value;
}

int main(int argc, char **argv) {
    CHECK(argc == 4);
    int missing=strcmp(argv[1], "missing")==0;
    unsigned int expected=strcmp(argv[1], "bound")==0 ? if_nametoindex(argv[2]) : 0;
    struct sockaddr_in local={.sin_len=sizeof(local),.sin_family=AF_INET,.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
    int listener=socket(AF_INET,SOCK_STREAM,0); CHECK(listener>=0);
    CHECK(bind(listener,(struct sockaddr *)&local,sizeof(local))==0);
    socklen_t size=sizeof(local); CHECK(getsockname(listener,(struct sockaddr *)&local,&size)==0);
    CHECK(listen(listener,1)==0);
    int client=socket(AF_INET,SOCK_STREAM,0); CHECK(client>=0);
    CHECK(connect(client,(struct sockaddr *)&local,sizeof(local))==0);
    CHECK(bound_interface(client)==0); // ADB/Frida TCP stays on loopback, even if the configured NIC vanishes.
    int accepted=accept(listener,NULL,NULL); CHECK(accepted>=0);
    close(accepted); close(client); close(listener);

    struct sockaddr_in remote={.sin_len=sizeof(remote),.sin_family=AF_INET,.sin_port=htons(9)};
    CHECK(inet_pton(AF_INET,"192.0.2.1",&remote.sin_addr)==1);
    int udp=socket(AF_INET,SOCK_DGRAM,0); CHECK(udp>=0);
    int result=connect(udp,(struct sockaddr *)&remote,sizeof(remote)); // UDP connect sends no packets.
    if(missing) CHECK(result==-1 && errno==ENODEV);
    CHECK(bound_interface(udp)==expected); close(udp);
    if(missing) return 0;

    // sendto/sendmsg to a receiver on this same Mac; no Internet or DNS needed.
    CHECK(inet_pton(AF_INET,argv[3],&local.sin_addr)==1); local.sin_port=0;
    int receiver=socket(AF_INET,SOCK_DGRAM,0); CHECK(receiver>=0);
    CHECK(bind(receiver,(struct sockaddr *)&local,sizeof(local))==0);
    size=sizeof(local); CHECK(getsockname(receiver,(struct sockaddr *)&local,&size)==0);
    struct timeval timeout={.tv_sec=2}; CHECK(setsockopt(receiver,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout))==0);
    char byte='x', received=0;
    for(int mode=0;mode<2;mode++) {
        udp=socket(AF_INET,SOCK_DGRAM,0); CHECK(udp>=0);
        if(mode==0) CHECK(sendto(udp,&byte,1,0,(struct sockaddr *)&local,sizeof(local))==1);
        else {
            struct iovec iov={.iov_base=&byte,.iov_len=1};
            struct msghdr msg={.msg_name=&local,.msg_namelen=sizeof(local),.msg_iov=&iov,.msg_iovlen=1};
            CHECK(sendmsg(udp,&msg,0)==1);
        }
        CHECK(bound_interface(udp)==expected);
        CHECK(recv(receiver,&received,1,0)==1 && received==byte); close(udp);
    }
    close(receiver); return 0;
}
