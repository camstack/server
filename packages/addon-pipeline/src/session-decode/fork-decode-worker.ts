/**
 * Real `fork` implementation for the session-decode coordinator — Epic C P1,
 * Task 4.
 *
 * Spawns the decode-worker child (`decode-worker-child.ts`, Task 2) as a
 * dedicated `child_process.fork` and adapts the returned `ChildProcess` to the
 * coordinator's minimal {@link ForkedChildLike} contract WITHOUT any cast —
 * an explicit forwarding wrapper, so a wider Node `ChildProcess` signature
 * never has to structurally satisfy the narrower interface.
 *
 * `serialization: 'advanced'` is MANDATORY: Node's default 'json' IPC
 * base64-serialises the `buffer` reply's `Uint8Array`, breaking the "raw
 * bytes, not base64" contract the coordinator + `worker-protocol.ts`'s
 * `value.bytes instanceof Uint8Array` guard both depend on. Advanced (V8
 * structured-clone) preserves the typed array on the wire.
 *
 * The child entry is resolved relative to THIS module's built location. Both
 * this module and `pipeline-runner/index.ts` bundle into the SAME entry
 * (`dist/pipeline-runner/index.js`, `manualChunks: () => null`), so
 * `import.meta.url` here is that file's URL and the sibling child lands at
 * `dist/session-decode/decode-worker-main.js` (its own vite build entry; the
 * worker class it runs is `decode-worker-child.ts`).
 */

import type { ChildProcess } from 'node:child_process'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { NO_COST_CLAIM, type ChildCostRegistry } from '@camstack/types/node'
import type { LiveDecodeWorkers } from './live-decode-workers.js'
import type { ForkedChildLike, WorkerExitInfo } from './session-decode-coordinator.js'
import type { VideoFrameSource } from './video-frame-generator.js'
import type { WorkerRequest } from './worker-protocol.js'

/** Absolute path to the built decode-worker child entry (a vite build entry). */
const CHILD_ENTRY_PATH = fileURLToPath(
  new URL('../session-decode/decode-worker-main.js', import.meta.url),
)

/**
 * Known kill signals the coordinator may pass, mapped to their `NodeJS.Signals`
 * literal so `ChildProcess.kill` receives a correctly-typed signal without a
 * cast. The coordinator only ever sends the default (undefined → SIGTERM) and
 * the SIGKILL fallback; anything unrecognised degrades to a plain `kill()`.
 */
const KILL_SIGNALS: Readonly<Record<string, NodeJS.Signals>> = {
  SIGKILL: 'SIGKILL',
  SIGTERM: 'SIGTERM',
}

/**
 * Adapt a Node {@link ChildProcess} to the coordinator's
 * {@link ForkedChildLike}.
 *
 * `onExit` is invoked exactly once, on the child's real exit, before the
 * coordinator's own listener — it is how the cost claim is released. It is a
 * parameter rather than a second `child.on('exit')` in the caller because
 * every listener added out here is one somebody can forget to remove.
 */
export function wrapChild(
  child: ChildProcess,
  onExit: () => void,
  killedByRunner: () => boolean = () => false,
): ForkedChildLike {
  // EXACTLY ONE exit reaches the coordinator and the cost claim. A child that
  // failed to SPAWN emits `error` and may never emit `exit` (Node documents
  // both), so that error is the exit: without it the session's live-worker
  // slot, returned only from the worker's exit (D652), was lost for good.
  let spawned = false
  let exitDelivered = false
  const exitListeners: Array<(info: WorkerExitInfo) => void> = []
  const deliverExit = (exit: WorkerExitInfo): void => {
    if (exitDelivered) return
    exitDelivered = true
    onExit()
    // A worker the runner itself killed on shutdown is not an unexpected
    // death: that kill already logged its own line per camera (D666).
    const info: WorkerExitInfo = killedByRunner() ? { ...exit, killedByRunner: true } : exit
    for (const listener of exitListeners) listener(info)
  }
  child.on('spawn', () => {
    spawned = true
  })
  child.on('exit', (code, signal) => deliverExit({ code: code ?? null, signal: signal ?? null }))
  // A send() racing the child's exit surfaces ERR_IPC_CHANNEL_CLOSED
  // ASYNCHRONOUSLY as an 'error' event on the ChildProcess — the coordinator's
  // synchronous try/catch around send() cannot observe it, and with no 'error'
  // listener the EventEmitter re-throws it as an uncaughtException that kills
  // the whole runner. Teardown/lease-release sends legitimately race worker
  // exit (fire-and-forget by design), so swallow the event; a dead child is
  // already handled via 'exit'.
  child.on('error', () => {
    if (!spawned) deliverExit({ code: null, signal: null })
  })
  return {
    send: (msg: WorkerRequest): void => {
      if (!child.connected) return
      // A callback routes an async channel-closed error here instead of the
      // 'error' event path.
      child.send(msg, () => undefined)
    },
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void): void => {
      // 'exit' forwards the real exit code/signal as a WorkerExitInfo — the
      // coordinator logs unexpected worker deaths (previously invisible).
      if (ev === 'exit') exitListeners.push(cb)
      else child.on('message', (m: unknown) => cb(m))
    },
    kill: (signal?: string): void => {
      if (signal === undefined) {
        child.kill()
        return
      }
      const mapped = KILL_SIGNALS[signal]
      if (mapped) child.kill(mapped)
      else child.kill()
    },
  }
}

/**
 * Fork one decode-worker child. `source` is part of the coordinator's fork
 * signature (it forwards the same source in the subsequent `start` message);
 * the child entry itself is source-independent, so it is not consumed here.
 *
 * The fork carries NO configuration. Until D453 it spread a set of
 * `*_SETTING` env vars in, because the child resolved its native-lease knobs
 * at module load; the knobs now travel on the `start` message
 * (`WorkerRequest.lease`), resolved in this process. That is what makes a
 * decode worker forkable BEFORE anyone knows which camera it will serve — a
 * child configured at spawn is a child bound to the configuration it was born
 * with — and it is what let the child bundle drop the Zod schemas that cost
 * every fork ~170 ms and ~100 MB of heap (D453).
 *
 * The inherited environment is SPREAD, never replaced: this child resolves
 * node-av through `CAMSTACK_FRAMEWORK_DIR` / `CAMSTACK_BUNDLED_ADDONS_DIR` on
 * agents, so a replaced env would silently break decoding off the hub.
 */
export function forkDecodeWorker(
  source: VideoFrameSource,
  deps?: ForkDecodeWorkerDeps,
): ForkedChildLike {
  return forkDecodeWorkerAt(CHILD_ENTRY_PATH, source, deps ?? {})
}

/** What a decode-worker fork is accounted in — both per runner PROCESS. */
export interface ForkDecodeWorkerDeps {
  /** Per-camera cost claim, taken at the fork, released at the exit. */
  readonly costRegistry?: ChildCostRegistry
  /**
   * The runner's live-worker set: the worker is in it from the fork to its
   * real exit, so the runner's shutdown can SIGKILL whatever is left (D666).
   */
  readonly liveWorkers?: LiveDecodeWorkers
}

/**
 * {@link forkDecodeWorker} with the entry named — the one seam a process-level
 * test needs to fork a stub through the REAL fork, claim and live-worker path.
 * Production forks only {@link CHILD_ENTRY_PATH}.
 */
export function forkDecodeWorkerAt(
  entryPath: string,
  source: VideoFrameSource,
  deps: ForkDecodeWorkerDeps,
): ForkedChildLike {
  const child = fork(entryPath, [], {
    serialization: 'advanced',
    env: { ...process.env },
  })
  // A decode session never spans two cameras, so this child IS one camera's
  // cost — and `source` was previously discarded here (`_source`), which is
  // exactly why that cost could not be read per camera. The claim is taken at
  // the fork, the only place that knows both the pid and the device, and
  // released on the child's exit.
  const costClaim =
    deps.costRegistry?.claim({
      role: 'decode',
      deviceId: source.deviceId,
      unit: `${source.deviceId}/decode`,
      pid: child.pid,
    }) ?? NO_COST_CLAIM
  let killedByRunner = false
  const untrack =
    deps.liveWorkers?.add({
      deviceId: source.deviceId,
      pid: child.pid,
      killNow: () => {
        killedByRunner = true
        child.kill('SIGKILL')
      },
    }) ?? ((): void => undefined)
  return wrapChild(
    child,
    () => {
      costClaim.release()
      untrack()
    },
    () => killedByRunner,
  )
}
