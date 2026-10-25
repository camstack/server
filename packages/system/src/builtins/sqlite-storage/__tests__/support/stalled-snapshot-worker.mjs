/**
 * A snapshot thread that never answers — the stall `SqliteSnapshotter`'s
 * deadline exists for (D693). It posts nothing, and appends a heartbeat byte
 * every 20 ms to `<db dir>/heartbeat`, so a spec can see whether the thread
 * was really terminated or merely abandoned (an abandoned one would keep a
 * pinned read open forever).
 */
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { workerData } from 'node:worker_threads'

const heartbeat = path.join(path.dirname(path.dirname(workerData.copyPath)), 'heartbeat')
setInterval(() => appendFileSync(heartbeat, '.'), 20)
