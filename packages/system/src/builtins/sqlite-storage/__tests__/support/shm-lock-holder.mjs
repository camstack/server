/**
 * The runner's side of `shm-lock-survives-a-second-open.spec.ts` — a process
 * shaped like `hub/sqlite-settings` (D679).
 *
 * It opens a WAL database the way the settings backend does (whole-file mmap,
 * the auto-checkpoint raised to the bound), grows the WAL past two 32 KiB
 * wal-index regions so it has three of them mapped, lets a PASSIVE checkpoint
 * restart the WAL small, and then runs the REAL checkpoint worker thread
 * (`wal-checkpoint-worker.ts`, loaded through tsx) for a while. Then it tells
 * the spec it is idle — the moment the nightly backup used to open the
 * database from hub-main — and waits for the word to write a burst that
 * crosses the next region boundary.
 *
 * Plain `.mjs` on purpose: the process must load with nothing but
 * `better-sqlite3`; only the worker thread needs the TypeScript loader.
 *
 * Protocol, one line each: stdout `READY` → stdin `BURST` → stdout `SURVIVED`.
 * A process whose wal-index was rebuilt under it does not print the last line:
 * it dies with SIGBUS.
 */
import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'

const [dbPath, workerSource, pollMsArg, workerRunMsArg] = process.argv.slice(2)
if (!dbPath || !workerSource) throw new Error('usage: shm-lock-holder.mjs <db> <worker.ts>')
const pollMs = Number(pollMsArg ?? '20')
const workerRunMs = Number(workerRunMsArg ?? '400')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('mmap_size = 1000000000')
db.pragma('wal_autocheckpoint = 0')
db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v BLOB NOT NULL)')
const insert = db.prepare('INSERT INTO t (v) VALUES (?)')
const payload = Buffer.alloc(600)
const write = (rows) => {
  for (let i = 0; i < rows; i++) insert.run(payload)
}

// > 8192 frames: this connection maps three wal-index regions.
write(12_000)
// Fold everything, then one write restarts the WAL at frame 1 — a small WAL,
// three regions still mapped. This is the runner's steady state.
db.pragma('wal_checkpoint(PASSIVE)')
write(1)

const worker = new Worker(workerSource, {
  workerData: { dbPath, pollMs, maxDelayMs: pollMs },
  execArgv: ['--import', 'tsx'],
})
await new Promise((resolve, reject) => {
  worker.once('error', reject)
  worker.on('message', (message) => {
    if (message && message.kind === 'ready') resolve()
  })
})
// Let the worker tick many times over the idle database.
await new Promise((resolve) => setTimeout(resolve, workerRunMs))

process.stdout.write('READY\n')
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  if (line.trim() !== 'BURST') continue
  // Crosses the 4096-frame region boundary of a WAL that restarted small.
  write(10_000)
  const stopped = new Promise((resolve) => worker.once('exit', resolve))
  worker.postMessage({ kind: 'stop' })
  await stopped
  db.close()
  process.stdout.write('SURVIVED\n')
  break
}
lines.close()
