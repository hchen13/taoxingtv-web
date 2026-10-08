import Java from 'frida-java-bridge';

// Java.perform attaches the calling thread; it does not make a blocking JNI call
// asynchronous. Run network work on real Java threads so RPC/control stays free.
// Posters have their own small pool and cannot fill the metadata queue.
const pools = new Map();
const jobs = new Map();
let Task = null, nextId = 1, closing = false, drained = null, closePromise = null;

function checkDrained() {
  if (closing && jobs.size === 0 && drained) { drained(); drained = null; }
}

export function javaNetwork(kind, work) {
  return new Promise((resolve, reject) => Java.perform(() => {
    let id, task;
    try {
      if (closing) throw new Error('取流引擎正在关闭');
      if (!Task) {
        Task = Java.registerClass({
          name: 'com.txtv.NetworkTask' + Date.now(),
          implements: [Java.use('java.lang.Runnable')],
          fields: { jobId: 'int' },
          methods: {
            run() {
              const id = this.jobId.value, job = jobs.get(id);
              if (!job) return;
              try { job.resolve(job.work()); }
              catch (e) { job.reject(new Error(String(e.stack || e))); }
              finally { jobs.delete(id); job.task.$dispose(); checkDrained(); }
            }
          }
        });
      }
      let pool = pools.get(kind);
      if (!pool) {
        const executor = Java.use('java.util.concurrent.Executors').newFixedThreadPool(2);
        pool = Java.retain(Java.cast(executor, Java.use('java.util.concurrent.ThreadPoolExecutor')));
        pool.setKeepAliveTime(10, Java.use('java.util.concurrent.TimeUnit').SECONDS.value);
        pool.allowCoreThreadTimeOut(true);
        pools.set(kind, pool);
      }
      id = nextId++;
      task = Java.retain(Task.$new());
      task.jobId.value = id;
      jobs.set(id, { resolve, reject, work, task });
      pool.execute(task);
    } catch (e) {
      if (id != null) jobs.delete(id);
      if (task) task.$dispose();
      reject(new Error(String(e.stack || e)));
    }
  }));
}

// Do not detach Frida while an executor still holds a generated Runnable: its
// native run() implementation belongs to this script. Cancel queued work and
// let running JNI calls return before unloading the script.
export function shutdownJavaNetwork() {
  if (closePromise) return closePromise;
  closing = true;
  closePromise = new Promise(resolve => {
    drained = resolve;
    Java.perform(() => {
      for (const pool of pools.values()) {
        const queued = pool.shutdownNow();
        for (let i = 0; i < queued.size(); i++) {
          const id = Java.cast(queued.get(i), Task).jobId.value;
          const job = jobs.get(id);
          if (!job) continue;
          jobs.delete(id);
          job.reject(new Error('取流引擎正在关闭'));
          job.task.$dispose();
        }
      }
      checkDrained();
    });
  });
  return closePromise;
}
