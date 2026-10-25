/**
 * A decode-worker process for `decode-worker-parent-loss.spec.ts` (D666): the
 * REAL process wiring (`wireDecodeWorkerProcess`) around a real
 * `DecodeWorkerChild`, minus node-av. The interval stands in for the worker's
 * `logMetrics`, the periodic raw-stderr write that turned a dead stderr reader
 * into an endless EPIPE → uncaughtException → EPIPE loop on the Mac agent.
 *
 * It also reports how many raw stderr writes the worker has ATTEMPTED, so a
 * worker that keeps writing to a dead pipe after the loss shows a count that
 * keeps climbing.
 */
import { wireDecodeWorkerProcess } from '../../decode-worker-process.js'

const { worker } = wireDecodeWorkerProcess(process)

// Count raw write ATTEMPTS without adding an 'error' listener: a listener
// here would itself stop an EPIPE from becoming an uncaught exception, and
// hide the very loop this fixture exists to reproduce.
let rawStderrWrites = 0
const originalWrite = process.stderr.write
Object.defineProperty(process.stderr, 'write', {
  configurable: true,
  writable: true,
  value: (...args: unknown[]): boolean => {
    rawStderrWrites += 1
    const accepted: unknown = Reflect.apply(originalWrite, process.stderr, args)
    return accepted === true
  },
})

setInterval(() => {
  worker.emitStderr('decode-worker-child: metrics\n', 'debug')
  // With a callback, like the worker's own sends: a send racing the channel's
  // close reports there instead of as an uncaught 'error' on `process`.
  if (process.connected) {
    process.send?.(
      { kind: 'fixture-stderr-writes', count: rawStderrWrites },
      undefined,
      undefined,
      () => undefined,
    )
  }
}, 50)
