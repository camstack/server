/**
 * Off-thread JS demux client — mp4box parse on a `worker_threads` Worker
 * inside the stream-broker runner (D228). Same addon, same WebRTC track;
 * the live restream event loop is not the one walking boxes.
 *
 * The worker file is a separate vite entry (`dist/stream-broker/demux-worker-child.js`).
 * This module is inlined into `dist/stream-broker/index.js`, so
 * `import.meta.url` is THAT file and the child is a sibling — the same
 * resolution trick as `fork-decode-worker.ts` / `decode-worker-main.js`.
 *
 * Missing worker file (vitest from `src/`, a botched deploy) falls back to
 * {@link demuxSegmentFullJs} on this thread. A worker that errors a job
 * returns null so {@link demuxSegmentPreferJs} takes the ffmpeg subprocess
 * (already off-loop) instead of re-running mp4box here.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  demuxSegmentFullJs,
  demuxSegmentPreferJs,
  type FullDemuxOptions,
  type JsParseFn,
} from './segment-demux-js.js'
import type { AccessUnit } from './segment-demux.js'
import type { IScopedLogger } from '@camstack/types'

/** Minimal Worker surface the client talks to — tests inject a fake. */
export interface DemuxWorkerLike {
  postMessage(value: unknown, transfer?: readonly Transferable[]): void
  on(event: 'message', listener: (value: unknown) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): void
  /** Node >= 22 `Worker#getHeapStatistics()`; absent on fakes that do not model it. */
  getHeapStatistics?(): Promise<DemuxWorkerHeapStats>
}

/** The three `v8.HeapInfo` fields the `[broker-mem]` probe sums over workers. */
export interface DemuxWorkerHeapStats {
  readonly total_heap_size: number
  readonly total_physical_size: number
  readonly used_heap_size: number
}

/**
 * What the `[broker-mem]` probe learns about the demux Worker(s): their own
 * isolate heap, which `process.memoryUsage()` of the main thread never shows.
 */
export interface DemuxWorkersReading {
  readonly workers: number
  readonly heapBytes: number
  readonly physicalBytes: number
  readonly usedBytes: number
  /** Age of the oldest live worker; 0 with none. */
  readonly maxAgeMs: number
  /** Whether the client terminates a quiet worker ({@link DEMUX_WORKER_IDLE_MS}). */
  readonly idleTerminates: boolean
}

/** The client: the parse function plus a probe accessor over its live worker. */
export interface OffThreadDemuxClient {
  readonly parse: JsParseFn
  /** Heap of every live worker. Async (`getHeapStatistics` is) — probe tick only. */
  readonly readHeaps: (now?: number) => Promise<DemuxWorkersReading>
}

/**
 * How long the demux Worker may sit with no parse in flight before it is
 * terminated and its isolate (about 144 MB of heap measured on the hub after
 * the first recorded demux) is returned to the OS. Recorded scrubbing is
 * bursty: a user drags, parses arrive every few hundred ms, then nothing for
 * minutes. 60 s keeps the worker warm across a scrub session (a respawn costs
 * a cold mp4box import) while a quiet broker holds no worker at all.
 */
export const DEMUX_WORKER_IDLE_MS = 60_000

/** The `worker_threads` `resourceLimits` fields the demux worker sets. */
export interface DemuxWorkerResourceLimits {
  readonly maxOldGenerationSizeMb: number
  readonly maxYoungGenerationSizeMb: number
}

/**
 * Heap shaping for the demux isolate. The runner's process-wide V8 flags
 * (`--initial-old-space-size=512`, `--max-semi-space-size=8`, from the
 * stream-broker manifest) are sized for the MAIN isolate and leak into every
 * Worker: with a 512 MB initial old space the worker grew to 144 MB of
 * garbage without a single major GC. Explicit `resourceLimits` replace the
 * inherited sizing (measured under those flags with the same allocation
 * churn: worker heap 474 MB without limits, 88 MB with them; see
 * the private session log).
 *
 * 128 MB old generation: parsing a recorded fragment retains about 1 MB
 * after GC for an 86 KB input (fixture bench), so even a 10 MB fragment (a
 * long 4K segment) holds well under 30 MB live; 128 MB is more than 4x that.
 * A parse that still exceeds it fails the worker cleanly
 * (`ERR_WORKER_OUT_OF_MEMORY`): in-flight parses resolve null (ffmpeg
 * fallback) and the next parse spawns a fresh worker.
 */
export const DEMUX_WORKER_RESOURCE_LIMITS: DemuxWorkerResourceLimits = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
}

/** Constructor options the client passes to the Worker. */
export interface DemuxWorkerOptions {
  readonly resourceLimits: DemuxWorkerResourceLimits
}

/** `new Worker(filename, options)` or a test fake that constructs the same surface. */
export type DemuxWorkerCtor = new (
  filename: string,
  options?: DemuxWorkerOptions,
) => DemuxWorkerLike

/** Timer pair, injectable so specs run on a fake clock. */
export interface DemuxTimers {
  readonly set: (fn: () => void, ms: number) => unknown
  readonly clear: (handle: unknown) => void
}

/** Injectable I/O so tests can prove fallback vs worker without a dist file. */
export interface OffThreadDemuxDeps {
  readonly workerFilename: string
  readonly existsSync: (path: string) => boolean
  readonly parseInProcess: JsParseFn
  readonly WorkerCtor?: DemuxWorkerCtor
  readonly logger?: IScopedLogger
  readonly idleMs?: number
  readonly timers?: DemuxTimers
  readonly now?: () => number
}

interface PendingParse {
  readonly resolve: (result: AccessUnit[] | null) => void
  readonly deviceId: number | undefined
}

/** One spawned worker and everything that belongs to ITS lifetime. */
interface WorkerSlot {
  readonly worker: DemuxWorkerLike
  readonly pending: Map<number, PendingParse>
  readonly spawnedAt: number
  idleTimer: unknown
  lastHeapBytes: number
}

const defaultTimers: DemuxTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref()
    return t
  },
  clear: (handle) => {
    if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout)
  },
}

type DemuxWorkerRequest = {
  readonly id: number
  readonly bytes: Uint8Array
}

function isCodec(value: unknown): value is AccessUnit['codec'] {
  return value === 'H264' || value === 'H265'
}

function isAccessUnit(value: unknown): value is AccessUnit {
  if (typeof value !== 'object' || value === null) return false
  if (!('data' in value) || !('ptsMs' in value) || !('keyframe' in value) || !('codec' in value)) {
    return false
  }
  return (
    value.data instanceof Uint8Array &&
    typeof value.ptsMs === 'number' &&
    typeof value.keyframe === 'boolean' &&
    isCodec(value.codec)
  )
}

function parseAus(value: unknown): AccessUnit[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) return null
  const aus: AccessUnit[] = []
  for (const item of value) {
    if (!isAccessUnit(item)) return null
    aus.push(item)
  }
  return aus
}

function parseWorkerMessage(
  message: unknown,
): { readonly id: number; readonly aus: AccessUnit[] | null } | null {
  if (typeof message !== 'object' || message === null) return null
  if (!('id' in message) || typeof message.id !== 'number') return null
  if ('ok' in message && message.ok === false) return { id: message.id, aus: null }
  if ('ok' in message && message.ok === true && 'aus' in message) {
    return { id: message.id, aus: parseAus(message.aus) }
  }
  return null
}

function defaultWorkerFilename(): string {
  return fileURLToPath(new URL('./demux-worker-child.js', import.meta.url))
}

/**
 * JS parse that posts each fragment to one process-wide Worker. Concurrent
 * callers are matched by request id; the worker's own event loop serializes
 * mp4box. Live RTP on the parent thread is not waiting on box parsing.
 */
export function createOffThreadJsParse(deps: OffThreadDemuxDeps): JsParseFn {
  return createOffThreadDemuxClient(deps).parse
}

/** {@link createOffThreadJsParse} plus the heap accessor the memory probe reads. */
export function createOffThreadDemuxClient(deps: OffThreadDemuxDeps): OffThreadDemuxClient {
  const Ctor = deps.WorkerCtor
  const idleMs = deps.idleMs ?? DEMUX_WORKER_IDLE_MS
  const timers = deps.timers ?? defaultTimers
  const now = deps.now ?? Date.now
  let current: WorkerSlot | null = null
  let nextId = 1

  const failAll = (slot: WorkerSlot, why: string): void => {
    const waiting = [...slot.pending.values()]
    slot.pending.clear()
    if (waiting.length > 0 && deps.logger) {
      for (const deviceId of new Set(waiting.map((p) => p.deviceId))) {
        deps.logger.warn(`demux worker lost with parses in flight (${why}) — ffmpeg fallback`, {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: { inFlight: waiting.length },
        })
      }
    }
    for (const p of waiting) p.resolve(null)
  }

  const retire = (slot: WorkerSlot): void => {
    timers.clear(slot.idleTimer)
    slot.idleTimer = undefined
    if (current === slot) current = null
  }

  const onIdle = async (slot: WorkerSlot): Promise<void> => {
    slot.idleTimer = undefined
    // A parse in flight is never cut; its resolution re-arms the timer.
    if (current !== slot || slot.pending.size > 0) return
    // Detach FIRST: a parse arriving from here on spawns a fresh worker.
    current = null
    const stats = await slot.worker.getHeapStatistics?.().catch(() => null)
    const heapBytes = stats?.total_heap_size ?? slot.lastHeapBytes
    deps.logger?.info('demux worker idle — terminating', {
      meta: {
        ageMs: Math.max(0, now() - slot.spawnedAt),
        idleMs,
        lastHeapMb: Math.round(heapBytes / 1048576),
      },
    })
    slot.worker.terminate()
  }

  const armIdle = (slot: WorkerSlot): void => {
    timers.clear(slot.idleTimer)
    slot.idleTimer = timers.set(() => void onIdle(slot), idleMs)
  }

  const attach = (slot: WorkerSlot): void => {
    const w = slot.worker
    w.on('message', (message: unknown) => {
      const parsed = parseWorkerMessage(message)
      if (!parsed) return
      const pending = slot.pending.get(parsed.id)
      if (!pending) return
      slot.pending.delete(parsed.id)
      pending.resolve(parsed.aus)
      if (slot.pending.size === 0 && current === slot) armIdle(slot)
    })
    w.on('error', (err: Error) => {
      retire(slot)
      failAll(slot, String(err))
    })
    w.on('exit', () => {
      retire(slot)
      failAll(slot, 'exit')
    })
  }

  const ensureWorker = (): WorkerSlot | null => {
    if (current) return current
    if (!Ctor) return null
    try {
      const worker = new Ctor(deps.workerFilename, {
        resourceLimits: DEMUX_WORKER_RESOURCE_LIMITS,
      })
      const slot: WorkerSlot = {
        worker,
        pending: new Map(),
        spawnedAt: now(),
        idleTimer: undefined,
        lastHeapBytes: 0,
      }
      attach(slot)
      current = slot
      deps.logger?.info('demux worker spawned', {
        meta: { resourceLimits: DEMUX_WORKER_RESOURCE_LIMITS, idleMs },
      })
      return slot
    } catch (err) {
      deps.logger?.warn(`demux worker spawn failed: ${String(err)} — parsing in-process`)
      return null
    }
  }

  const parse: JsParseFn = async (bytes, ctx): Promise<AccessUnit[] | null> => {
    if (!deps.existsSync(deps.workerFilename)) {
      return deps.parseInProcess(bytes)
    }
    const slot = ensureWorker()
    if (!slot) return deps.parseInProcess(bytes)
    timers.clear(slot.idleTimer)
    slot.idleTimer = undefined

    const id = nextId
    nextId += 1
    // `new Uint8Array(bytes)`, NOT `bytes.slice()`.
    //
    // `.slice()` COPIES for a plain `Uint8Array` and ALIASES for a Node
    // `Buffer` — `Buffer.prototype.slice` is `subarray`. This parameter is
    // typed `Uint8Array` and a `Buffer` IS one, so the type system cannot tell
    // them apart while the two behave OPPOSITELY here: with a Buffer, the
    // transfer below detached the caller's own array.
    //
    // Measured cost of getting it wrong (2026-08-26, camera 3839): every COLD
    // seek froze for `AUDIO_DEMUX_TIMEOUT_MS` in full — p50 1 498 ms against
    // 6 ms on a warm seek, 129×. The video demux SUCCEEDED and then every later
    // read of the same bytes saw 0 (`readBytes` 0 on 487/487 whole reads,
    // `bytes` 0 on 55/55 seeks), so the audio branch sliced an empty range and
    // fell through to an ffmpeg fallback fed empty stdin. Recorded audio was
    // silently dead on every cold seek for as long as this line existed.
    const copy = new Uint8Array(bytes)
    const request: DemuxWorkerRequest = { id, bytes: copy }
    return new Promise<AccessUnit[] | null>((resolve) => {
      slot.pending.set(id, { resolve, deviceId: ctx?.deviceId })
      slot.worker.postMessage(request, [copy.buffer])
    })
  }

  const readHeaps = async (at: number = Date.now()): Promise<DemuxWorkersReading> => {
    const live = current
    const empty: DemuxWorkersReading = {
      workers: 0,
      heapBytes: 0,
      physicalBytes: 0,
      usedBytes: 0,
      maxAgeMs: 0,
      idleTerminates: true,
    }
    if (live === null) return empty
    const stats = await live.worker.getHeapStatistics?.().catch(() => null)
    if (stats) live.lastHeapBytes = stats.total_heap_size
    return {
      ...empty,
      workers: 1,
      maxAgeMs: Math.max(0, at - live.spawnedAt),
      ...(stats
        ? {
            heapBytes: stats.total_heap_size,
            physicalBytes: stats.total_physical_size,
            usedBytes: stats.used_heap_size,
          }
        : {}),
    }
  }

  return { parse, readHeaps }
}

function defaultOffThreadClient(): OffThreadDemuxClient {
  return createOffThreadDemuxClient({
    workerFilename: defaultWorkerFilename(),
    existsSync,
    parseInProcess: demuxSegmentFullJs,
    WorkerCtor: Worker,
    ...(sharedLogger ? { logger: sharedLogger } : {}),
  })
}

let shared: OffThreadDemuxClient | undefined

/** Process-wide JS parse: one Worker, shared by every WebRTC session. */
export const offThreadJsParse: JsParseFn = (bytes, ctx) => {
  shared ??= defaultOffThreadClient()
  return shared.parse(bytes, ctx)
}

let sharedLogger: IScopedLogger | undefined

/** Give the process-wide client a logger; call before the first parse. */
export function setDemuxWorkerLogger(logger: IScopedLogger): void {
  sharedLogger = logger
}

/** Heap of the shared demux worker, for the `[broker-mem]` probe (tick only). */
export async function readDemuxWorkerHeaps(now?: number): Promise<DemuxWorkersReading> {
  return shared
    ? shared.readHeaps(now)
    : {
        workers: 0,
        heapBytes: 0,
        physicalBytes: 0,
        usedBytes: 0,
        maxAgeMs: 0,
        idleTerminates: true,
      }
}

/**
 * Drop-in for the session `demuxVideo` hook: JS parse off the live loop,
 * ffmpeg subprocess fallback unchanged.
 */
export async function demuxSegmentPreferJsOffThread(
  bytes: Uint8Array,
  opts: FullDemuxOptions,
): Promise<AccessUnit[]> {
  return demuxSegmentPreferJs(bytes, { ...opts, jsParse: offThreadJsParse })
}
