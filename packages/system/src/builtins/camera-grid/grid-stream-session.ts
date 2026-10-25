/**
 * One composite camera's stream, on demand.
 *
 * ## The lifecycle, stated once
 *
 * There is **no prebuffer and no idle stream**. The child exists while, and
 * only while, somebody is reading its bytes:
 *
 * - **A consumer** is an open read of this grid's HTTP endpoint. The broker is
 *   the only thing that dials it, and it dials on demand for whatever is
 *   consuming the grid's profile slot — a viewer, a snapshot, or the recorder.
 *   That is why "the recorder counts as a client" needs no special case here:
 *   with recording enabled the broker keeps a dial open, so the grid stays up
 *   exactly like an ordinary camera that records.
 * - **The first** consumer acquires one broker handle per cell and starts ONE
 *   ffmpeg child.
 * - **The last** consumer to leave stops the child and releases every handle.
 *   {@link GridStreamSessionDeps.lingerMs} debounces that teardown; it holds no
 *   media and answers nobody, it only stops a reconnect costing a respawn plus
 *   N re-acquisitions.
 *
 * ## Why the sources come from the broker
 *
 * `streamBroker.getStreamWithCodec` is the single demand-counted stream entry
 * point: it rides the broker's ONE dial to each source camera rather than
 * opening a second connection, and it is refcounted, so a source that also
 * feeds a viewer is not dialled twice. A grid that dialled cameras itself would
 * double every source's connection count and wake battery cameras nobody asked
 * for.
 */
import type { FfmpegVideoEncoderId, IScopedLogger } from '@camstack/types'
import { FlvJoinPoint, type FlvReader } from './flv-join.js'
import { errMsg } from '@camstack/types'
import type { Readable } from 'node:stream'
import type { GridLayout } from './grid-filter-graph.js'

/** The logging surface this session needs — a structural subset of the injected logger. */
export type GridStreamLogger = Pick<IScopedLogger, 'debug' | 'info' | 'warn' | 'error'>

/** One acquired broker handle: what to dial, and what to release it by. */
export interface GridSourceHandle {
  readonly url: string
  readonly pipelineKey: string
}

/** The spawned ffmpeg, as this session uses it. */
export interface GridStreamChild {
  readonly stdout: Readable
  stop(): Promise<void>
}

/** Everything the composition needs that is not a per-run acquisition. */
export interface GridStreamPlan {
  readonly layout: GridLayout
  /** In ffmpeg INPUT ORDINAL order — `sourceDeviceIds[n]` is the graph's `[n:v]`. */
  readonly sourceDeviceIds: readonly number[]
  readonly encoder: FfmpegVideoEncoderId
  readonly decodeHwAccel: string | null
  readonly fps: number
  readonly bitrateKbps: number
}

export interface GridStreamSessionDeps {
  readonly logger: GridStreamLogger
  readonly acquireSource: (deviceId: number) => Promise<GridSourceHandle>
  readonly releaseSource: (pipelineKey: string) => Promise<void>
  readonly startChild: (
    plan: GridStreamPlan,
    sources: readonly GridSourceHandle[],
  ) => Promise<GridStreamChild>
  /** Teardown debounce. `0` ⇒ tear down the moment the last consumer leaves. */
  readonly lingerMs?: number
}

export interface GridStreamConsumer {
  readonly onData: (chunk: Buffer) => void
  /** Called once, with WHY, when this consumer's stream ends from our side. */
  readonly onClose: (reason: string) => void
}

export interface GridStreamHold {
  close(): void
}

export interface GridStreamSessionOptions {
  /** The COMPOSITE camera's device id — every log line here is tagged with it. */
  readonly deviceId: number
  readonly deps: GridStreamSessionDeps
  /**
   * The current composition, re-read on every cold start. `null` ⇒ the grid has
   * no cells yet, which is the normal state of a freshly created grid.
   */
  readonly resolvePlan: () => GridStreamPlan | null
}

interface RunningState {
  readonly child: GridStreamChild
  readonly sources: readonly GridSourceHandle[]
}

const DEFAULT_LINGER_MS = 3_000

export class GridStreamSession {
  private readonly consumers = new Map<GridStreamConsumer, FlvReader>()
  /**
   * The FLV stream's describing bytes, and where each reader may start.
   *
   * Rebuilt with every cold start: a new child means a new header and a new
   * sequence header, and handing a reader the previous child's would decode
   * noise. See `flv-join.ts` for why FLV needs this and MPEG-TS did not.
   */
  private join = new FlvJoinPoint()
  private running: RunningState | null = null
  private starting: Promise<RunningState> | null = null
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private teardown: Promise<void> | null = null
  private disposed = false

  constructor(private readonly options: GridStreamSessionOptions) {}

  private get logTags(): { readonly deviceId: number } {
    return { deviceId: this.options.deviceId }
  }

  /** The COMPOSITE camera's device id — what every log line about this grid is tagged with. */
  get deviceId(): number {
    return this.options.deviceId
  }

  isRunning(): boolean {
    return this.running !== null
  }

  consumerCount(): number {
    return this.consumers.size
  }

  /** Resolves once any in-flight start or teardown has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.starting?.catch(() => undefined)
    await this.teardown
  }

  /**
   * Attach a consumer, starting the composition if this is the first one.
   *
   * @throws when the grid has nothing to compose, or a source could not be
   * acquired. Both are LOGGED before they are thrown: a branch that accepts a
   * consumer and then produces no media is exactly the branch that reads as
   * "nothing ever happened".
   */
  async open(consumer: GridStreamConsumer): Promise<GridStreamHold> {
    if (this.disposed) throw new Error('camera-grid: this stream session is disposed')
    this.cancelLinger()
    this.consumers.set(consumer, this.join.join())
    try {
      await this.ensureRunning()
    } catch (error) {
      this.dropConsumer(consumer)
      this.scheduleTeardownIfIdle()
      throw error
    }
    let closed = false
    return {
      close: () => {
        if (closed) return
        closed = true
        this.dropConsumer(consumer)
        this.options.deps.logger.debug('camera grid: consumer left', {
          tags: this.logTags,
          meta: { remaining: this.consumers.size },
        })
        this.scheduleTeardownIfIdle()
      },
    }
  }

  /**
   * Attach to a composition that is ALREADY running, or refuse.
   *
   * The whole difference from {@link open} is the refusal, and the refusal is
   * the feature. A snapshot of a grid is a frame of the composition — which
   * only exists while something is watching it — and the operator's rule is
   * that producing a thumbnail must never be the reason N cameras get dialled.
   * `open()` would start the composition, acquire every source, and on a
   * battery camera that is a wake nobody asked for.
   *
   * `null` is a real answer: "there is no composition to take a frame from",
   * which the caller turns into the stored last frame, or into nothing.
   */
  openIfRunning(consumer: GridStreamConsumer): GridStreamHold | null {
    if (this.disposed || this.running === null) return null
    this.cancelLinger()
    this.consumers.set(consumer, this.join.join())
    let closed = false
    return {
      close: () => {
        if (closed) return
        closed = true
        this.dropConsumer(consumer)
        this.scheduleTeardownIfIdle()
      },
    }
  }

  /** Forget a consumer AND the reader holding bytes on its behalf. */
  private dropConsumer(consumer: GridStreamConsumer): void {
    this.consumers.get(consumer)?.close()
    this.consumers.delete(consumer)
  }

  /**
   * The child ended on its own. Every consumer is told WHY — a stream that
   * simply stops is indistinguishable from a stalled one at the far end.
   */
  onChildEnded(reason: string): void {
    if (this.running === null) return
    this.options.deps.logger.warn('camera grid: the composition ended', {
      tags: this.logTags,
      meta: { reason, consumers: this.consumers.size },
    })
    for (const [consumer, reader] of [...this.consumers]) {
      reader.close()
      consumer.onClose(reason)
    }
    this.consumers.clear()
    this.teardown = this.stopNow()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelLinger()
    for (const [consumer, reader] of [...this.consumers]) {
      reader.close()
      consumer.onClose('shutdown')
    }
    this.consumers.clear()
    await this.settled()
    await this.stopNow()
  }

  private async ensureRunning(): Promise<RunningState> {
    if (this.running) return this.running
    if (this.starting) return this.starting
    const starting = this.startCold()
    this.starting = starting
    try {
      const state = await starting
      this.running = state
      return state
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  private async startCold(): Promise<RunningState> {
    const plan = this.options.resolvePlan()
    if (plan === null || plan.layout.cells.length === 0 || plan.sourceDeviceIds.length === 0) {
      // Accepted a consumer, produced nothing. Silence here reads as a broken
      // camera; the operator's actual state is "this grid has no cells yet".
      this.options.deps.logger.warn(
        'camera grid: a consumer attached but the grid has no cells — nothing to compose',
        { tags: this.logTags },
      )
      throw new Error('camera-grid: this grid has no cells to compose')
    }

    const acquired: GridSourceHandle[] = []
    try {
      for (const sourceDeviceId of plan.sourceDeviceIds) {
        acquired.push(await this.options.deps.acquireSource(sourceDeviceId))
      }
    } catch (error) {
      // Never leak a broker refcount on a partial acquisition: a leaked handle
      // keeps a source camera dialled forever with nobody watching it.
      this.options.deps.logger.error(
        'camera grid: could not acquire every source — releasing the ones already taken',
        { tags: this.logTags, meta: { acquired: acquired.length, error: errMsg(error) } },
      )
      await this.releaseAll(acquired)
      throw error
    }

    try {
      // A fresh child is a fresh FLV stream: its header and sequence header
      // replace the previous ones, and a reader that was mid-stream starts over
      // at the next key frame rather than being fed two encoders' bytes.
      this.join = new FlvJoinPoint()
      for (const consumer of this.consumers.keys()) this.consumers.set(consumer, this.join.join())
      const child = await this.options.deps.startChild(plan, acquired)
      child.stdout.on('data', (chunk: Buffer) => {
        this.join.accept(chunk)
        for (const [consumer, reader] of this.consumers) {
          const owed = reader.take()
          if (owed !== null) consumer.onData(owed)
        }
      })
      this.options.deps.logger.info('camera grid: composition started', {
        tags: this.logTags,
        meta: {
          cells: plan.layout.cells.length,
          sources: [...plan.sourceDeviceIds],
          canvas: `${String(plan.layout.width)}x${String(plan.layout.height)}`,
          fps: plan.fps,
        },
      })
      return { child, sources: acquired }
    } catch (error) {
      this.options.deps.logger.error('camera grid: the composition failed to start', {
        tags: this.logTags,
        meta: { error: errMsg(error) },
      })
      await this.releaseAll(acquired)
      throw error
    }
  }

  private scheduleTeardownIfIdle(): void {
    if (this.consumers.size > 0) return
    if (this.running === null && this.starting === null) return
    const lingerMs = this.options.deps.lingerMs ?? DEFAULT_LINGER_MS
    if (lingerMs <= 0) {
      this.teardown = this.stopNow()
      return
    }
    this.cancelLinger()
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null
      if (this.consumers.size > 0) return
      this.teardown = this.stopNow()
    }, lingerMs)
    this.lingerTimer.unref?.()
  }

  private cancelLinger(): void {
    if (this.lingerTimer === null) return
    clearTimeout(this.lingerTimer)
    this.lingerTimer = null
  }

  private async stopNow(): Promise<void> {
    const state = this.running
    this.running = null
    if (state === null) return
    try {
      await state.child.stop()
    } catch (error) {
      this.options.deps.logger.warn('camera grid: the composition did not stop cleanly', {
        tags: this.logTags,
        meta: { error: errMsg(error) },
      })
    }
    await this.releaseAll(state.sources)
    this.options.deps.logger.info('camera grid: composition stopped — no consumers left', {
      tags: this.logTags,
      meta: { released: state.sources.length },
    })
  }

  private async releaseAll(sources: readonly GridSourceHandle[]): Promise<void> {
    for (const source of sources) {
      try {
        await this.options.deps.releaseSource(source.pipelineKey)
      } catch (error) {
        // A failed release is a source left dialled. It must be visible.
        this.options.deps.logger.error('camera grid: could NOT release a source handle', {
          tags: this.logTags,
          meta: { pipelineKey: source.pipelineKey, error: errMsg(error) },
        })
      }
    }
  }
}
