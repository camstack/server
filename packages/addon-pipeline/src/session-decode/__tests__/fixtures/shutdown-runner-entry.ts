/**
 * A pipeline-runner stand-in for `decode-worker-shutdown-kill.spec.ts` (D666).
 *
 * It forks one worker through the REAL runner wiring (`RunnerDecodeWorkers`
 * over `forkDecodeWorkerAt`, only the entry swapped for a stub that never
 * exits), with the real `process` as its exit hook, and reports the stub's pid.
 * Then it ends the way the addon runner can:
 *
 * - `graceful`: on SIGTERM, the addon's shutdown kill and `process.exit(0)`
 *   in the same turn — `addon-runner.ts`'s `shutdown()`.
 * - `crash`: on a `crash` message, an uncaught error, which the same handler
 *   as `addon-runner.ts` turns into `process.exit(1)` — `onShutdown` never runs.
 */
import { fileURLToPath } from 'node:url'
import { ChildCostRegistry } from '@camstack/types/node'
import { forkDecodeWorkerAt } from '../../fork-decode-worker.js'
import { RunnerDecodeWorkers } from '../../live-decode-workers.js'

const STUB = fileURLToPath(new URL('./stuck-worker-stub.mjs', import.meta.url))
const mode = process.argv[2] === 'crash' ? 'crash' : 'graceful'

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}
const workers = new RunnerDecodeWorkers({
  fork: (source, deps) => forkDecodeWorkerAt(STUB, source, deps),
  costRegistry: new ChildCostRegistry(),
  logger: { info: log, warn: log },
  process,
})
const child = workers.fork({ restreamUrl: 'rtsp://fixture/1', deviceId: 101, codec: 'h264' })
child.on('message', (message) => {
  process.send?.(message)
})

if (mode === 'graceful') {
  process.on('SIGTERM', () => {
    workers.shutdown()
    process.exit(0)
  })
} else {
  // `addon-runner.ts`: an uncaught error ends the runner with exit(1).
  process.on('uncaughtException', () => {
    process.exit(1)
  })
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    if (!('kind' in message) || message.kind !== 'crash') return
    setTimeout(() => {
      throw new Error('runner crashed')
    }, 0)
  })
}
