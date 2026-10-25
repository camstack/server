/**
 * Benchmark loads never go into the live detection pool (D910).
 *
 * 2026-10-22, hub: `benchmark.runPipelineTest` loaded `yolov9m-320-int8` into
 * the LIVE `openvino:gpu` worker and the iGPU compiler took that worker down
 * three times in 15 s — camera 101's detection and clip embeddings with it,
 * until the respawn. A benchmark names models nobody has run on this device
 * (it is how an operator tries them), so its loads are the likeliest compiles
 * to be cold and the likeliest to be fatal. They get a pool of their own.
 *
 * What a benchmark run is, by the SHAPE of its input: a one-shot image
 * (`image` / `referenceImage`) with no camera, no replay and no live frame.
 * The live path always carries a `frame`/`frameRef`; a replay is the camera's
 * own stored media (D56); the capacity ramp and the synthetic bench send raw
 * frames. No cap field is added for it — the shape already says it.
 *
 * The pool is a SEPARATE worker per device, built on first use, reused by the
 * next benchmark call (so the timed runs measure a warm model on the same
 * device, exactly as before) and reclaimed after {@link BENCHMARK_POOL_IDLE_TTL_MS}
 * of silence. It is never in `factoriesByDevice`, so its death is not charged
 * to the device's restart budget and its failures are not a verdict about the
 * live device.
 */
import type { PipelineRunInput } from '@camstack/types'
import { IdlePoolReaper } from './idle-pool-reaper.js'

/** A benchmark pool idle this long is disposed; the next benchmark builds it again. */
export const BENCHMARK_POOL_IDLE_TTL_MS = 5 * 60_000

/** The key a benchmark's model loads are tracked under, apart from the live device's. */
export const BENCHMARK_KEY_PREFIX = 'bench:'

export function benchmarkKeyOf(deviceKey: string): string {
  return `${BENCHMARK_KEY_PREFIX}${deviceKey}`
}

/** True for the one-shot UI benchmark call — see the file header for why the shape is enough. */
export function isBenchmarkRun(
  input: Pick<PipelineRunInput, 'frame' | 'frameRef' | 'deviceId' | 'replay'>,
): boolean {
  return (
    input.frame === undefined &&
    input.frameRef === undefined &&
    input.deviceId === undefined &&
    input.replay !== true
  )
}

/**
 * Backends whose device opens in ONE process at a time. libedgetpu holds an
 * Edge TPU exclusively for the process that opened it, so a second pool on a
 * Coral the cameras' pool already holds cannot open it at all — every
 * benchmark and auto-benchmark (D913) of an in-use Coral failed that way on
 * the dev hub (1.2.619). Every other backend this node builds (OpenVINO,
 * CoreML, CUDA, ONNX, CPU) shares its device between processes.
 */
const EXCLUSIVE_BACKENDS: ReadonlySet<string> = new Set(['edgetpu'])

/** True when the device behind `deviceKey` (`<backend>:<device>`) cannot be opened by a second pool. */
export function isExclusiveDevice(deviceKey: string): boolean {
  const colon = deviceKey.indexOf(':')
  const backend = colon >= 0 ? deviceKey.slice(0, colon) : deviceKey
  return EXCLUSIVE_BACKENDS.has(backend)
}

/** Where a call's models load: its own benchmark pool (D910), or the device's live pool. */
export type BenchmarkPlacement = 'benchmark-pool' | 'live-pool'

/**
 * A benchmark on an EXCLUSIVE device is the one benchmark that goes to the
 * live pool: the separate pool could not open the device, so the choice is
 * between measuring through the cameras' pool and not measuring at all.
 */
export function benchmarkPlacementOf(benchmark: boolean, deviceKey: string): BenchmarkPlacement {
  return benchmark && !isExclusiveDevice(deviceKey) ? 'benchmark-pool' : 'live-pool'
}

/** The two members of a pool the registry below needs. */
export interface BenchmarkPool {
  isReady(): boolean
  dispose(): Promise<void>
}

export interface BenchmarkPoolsOptions<P extends BenchmarkPool, E> {
  /** Spawn and initialise a fresh pool for `engine`; rejects when it cannot come up. */
  readonly create: (deviceKey: string, engine: E) => Promise<P>
  readonly onDisposeError?: (deviceKey: string, err: unknown) => void
  readonly ttlMs?: number
}

export class BenchmarkPools<P extends BenchmarkPool, E> {
  private readonly pools = new Map<string, P>()
  private readonly inflight = new Map<string, Promise<P>>()
  private readonly reaper: IdlePoolReaper

  constructor(private readonly options: BenchmarkPoolsOptions<P, E>) {
    this.reaper = new IdlePoolReaper({
      ttlMs: options.ttlMs ?? BENCHMARK_POOL_IDLE_TTL_MS,
      dispose: (key) => this.disposeOne(key),
      onError: (key, err) => options.onDisposeError?.(key, err),
    })
  }

  /** The benchmark pool for `deviceKey`: warm if one is up, otherwise built (single-flight). */
  async acquire(deviceKey: string, engine: E): Promise<P> {
    const existing = this.pools.get(deviceKey)
    if (existing) {
      if (existing.isReady()) {
        this.reaper.touch(deviceKey)
        return existing
      }
      // A benchmark pool that died is simply replaced: nothing live depends on it.
      this.pools.delete(deviceKey)
      this.reaper.cancel(deviceKey)
      await existing.dispose().catch(() => undefined)
    }
    const pending = this.inflight.get(deviceKey)
    if (pending) return pending
    const creation = (async (): Promise<P> => {
      const pool = await this.options.create(deviceKey, engine)
      this.pools.set(deviceKey, pool)
      this.reaper.touch(deviceKey)
      return pool
    })()
    this.inflight.set(deviceKey, creation)
    try {
      return await creation
    } finally {
      this.inflight.delete(deviceKey)
    }
  }

  /** The device keys that currently hold a benchmark pool. */
  deviceKeys(): readonly string[] {
    return [...this.pools.keys()]
  }

  async disposeAll(): Promise<void> {
    this.reaper.disposeAll()
    const pools = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(pools.map((p) => p.dispose().catch(() => undefined)))
  }

  private async disposeOne(deviceKey: string): Promise<void> {
    const pool = this.pools.get(deviceKey)
    if (!pool) return
    this.pools.delete(deviceKey)
    await pool.dispose()
  }
}
