// A decode worker that never ends on its own: no disconnect handler, no
// SIGTERM handler, a live timer — the stand-in for a worker parked in a native
// call. Only the parent's SIGKILL ends it (D666).
process.send?.({ kind: 'stub-up', pid: process.pid })
setInterval(() => {}, 1000)
