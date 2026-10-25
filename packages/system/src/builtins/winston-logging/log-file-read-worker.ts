/**
 * The rotated-file reader thread (D898) — a worker of whichever process runs
 * `winston-logging`, so scanning and indexing a day of logs never runs on that
 * process's event loop.
 *
 * A separate bundle (`dist/log-file-read-worker.js`, wired in
 * `vite.config.ts`). It imports nothing from the kernel: the index, the
 * reader and the shared line filter.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { LogFileIndexStore } from './log-file-index-store.js'
import {
  CancelBook,
  isToReader,
  serveRead,
  type FromReader,
  type ReadWorkerData,
} from './log-file-read-protocol.js'

function isWorkerData(value: unknown): value is ReadWorkerData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'logsDir' in value &&
    typeof value.logsDir === 'string' &&
    'backgroundPassMs' in value &&
    typeof value.backgroundPassMs === 'number'
  )
}

const port = parentPort
if (port === null || !isWorkerData(workerData)) {
  throw new Error('log-file-read-worker: started without a parent port or worker data')
}
const data: ReadWorkerData = workerData
const store = new LogFileIndexStore(data.logsDir)
const cancels = new CancelBook()
let stopping = false
let passRunning = false

async function backgroundPass(): Promise<void> {
  if (passRunning || stopping) return
  passRunning = true
  try {
    await store.backgroundPass(() => stopping)
  } catch {
    /* the next pass retries; a read never depends on it */
  } finally {
    passRunning = false
  }
}

const timer =
  data.backgroundPassMs > 0 ? setInterval(() => void backgroundPass(), data.backgroundPassMs) : null
if (data.backgroundPassMs > 0) void backgroundPass()

port.on('message', (message: unknown) => {
  if (!isToReader(message)) return
  if (message.type === 'stop') {
    stopping = true
    if (timer !== null) clearInterval(timer)
    port.close()
    return
  }
  if (message.type === 'cancel') {
    cancels.cancel(message.requestId)
    return
  }
  const { id, query } = message
  serveRead(data.logsDir, store, cancels, query).then(
    (outcome) => {
      const reply: FromReader = { type: 'result', id, result: outcome.result }
      port.postMessage(reply)
    },
    (error: unknown) => {
      const reply: FromReader = {
        type: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      }
      port.postMessage(reply)
    },
  )
})
