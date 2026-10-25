/**
 * Fmp4FragmentChild — one ffmpeg writing a fragmented MP4 to stdout, split into
 * units and fanned out on a {@link Fmp4FragmentPlane}.
 *
 * ## Why this lives in the PRIMITIVE and not in the broker
 *
 * It was written as the stream-broker's third egress transport, on the premise
 * ([D80](../../../../docs/decisions/adr-0080.md)) that its consumers would be
 * in-process with the broker and could hold a live plane object. **They are
 * not.** `addon-export-hap` — the HKSV recording delegate, the first real
 * consumer — is a `hub-only` addon in its OWN runner ([D2](../../../../docs/decisions/adr-0002.md)),
 * and a plane cannot cross a process boundary. The choice was a second copy of
 * the splitter in the exporter, or one copy here beside the sink that produces
 * the bytes. The sink, the splitter, the plane and this child are one primitive
 * ([D84](../../../../docs/decisions/adr-0084.md)); `EgressTranscodeManager`
 * keeps only what is broker business — sharing key, refcount, release grace.
 *
 * It is deliberately the same shape as `TranscodeEgress` (the dial transport)
 * and `createPushChild` (the push one), because the three failures that cost
 * sessions on those paths are the same three here:
 *
 *  - **It resolves on the first UNIT, never on the first byte.** A child whose
 *    bytes do not parse as fMP4 is a child that will never produce a fragment,
 *    and resolving on bytes hands the caller a handle nothing feeds.
 *  - **It retries once in SOFTWARE.** `-hwaccel vaapi` fails to create a device
 *    inside the stream-broker runner on the live hub (`code=244`), and the push
 *    transport was dark for exactly as long as it lacked this retry.
 *  - **A child that dies AFTER going live says so.** Silence reads as "it is
 *    running"; the plane must be ended so a consumer's generator completes
 *    rather than hanging on a producer that no longer exists.
 *
 * Two consumers: `EgressTranscodeManager.acquireFragments` (the broker, for a
 * future CamStack clip source — roadmap 4b half 2) and `HksvFragmentSource` in
 * `addon-export-hap`. It stays unreachable from `acquireEgressTranscode`'s
 * request schema on purpose (see `egressTransportFromRequest`): a plane is a
 * live object, so an off-node caller could not use one anyway.
 */

import type { IScopedLogger } from '../interfaces/logging.js'
import { errMsg } from '../utils/err-msg.js'
import type { FfmpegInvocation } from './invocation.js'
import { buildFfmpegArgs, isSoftwareDecode } from './invocation.js'
import type { FfmpegSpawnFn, SpawnedFfmpegProcess } from './process.js'

import { Fmp4BoxSplitter } from './fmp4-box-splitter.js'
import type { Fmp4FragmentPlane } from './fmp4-fragment-plane.js'

export interface Fmp4FragmentChildDeps {
  readonly logger: IScopedLogger
  readonly ffmpegBinaryPath: string
  readonly spawnFn: FfmpegSpawnFn
  /** How long the child may produce no UNIT before it is declared dead. */
  readonly firstUnitTimeoutMs?: number
  /** The child exited, or its output stopped parsing, AFTER it went live. */
  readonly onChildExit?: (error: Error) => void
}

export interface Fmp4FragmentChildArgs {
  readonly sourceId: string
  /** Every line about this child is grouped per camera, without exception. */
  readonly deviceId: number
  /** The negotiated fragment length — argv only; the splitter never reads it. */
  readonly fragmentMs: number
  /** The invocation minus the sink, which this child owns. */
  readonly invocation: Omit<FfmpegInvocation, 'sink' | 'audioSidecar'>
  /** Where the units go. Owned by the caller, ended by this child. */
  readonly plane: Fmp4FragmentPlane
}

const DEFAULT_FIRST_UNIT_TIMEOUT_MS = 12_000

/** Heartbeat cadence — ~2 minutes of 4 s fragments. */
const FRAGMENT_LOG_EVERY = 30

export class Fmp4FragmentChild {
  private child: SpawnedFfmpegProcess | null = null
  private splitter = new Fmp4BoxSplitter()
  private stopped = false
  private unitsOut = 0
  private activeHwAccel: string | null = null

  constructor(
    private readonly deps: Fmp4FragmentChildDeps,
    private readonly args: Fmp4FragmentChildArgs,
  ) {}

  /** Spawn, and resolve once the INIT segment has been cut out of stdout. */
  async start(): Promise<void> {
    const requested = this.args.invocation.decodeHwAccel
    this.activeHwAccel = requested
    try {
      await this.spawnAttempt(requested)
      return
    } catch (err) {
      if (this.stopped) throw err
      if (requested === null || isSoftwareDecode(requested)) throw err
      this.deps.logger.warn(
        'fmp4 fragment child: hardware decode produced NO fragment — retrying in SOFTWARE',
        {
          tags: { deviceId: this.args.deviceId },
          meta: {
            sourceId: this.args.sourceId,
            decodeHwAccel: requested,
            error: errMsg(err),
          },
        },
      )
      this.killChild()
      // A fresh splitter: the dead child's partial box is not a prefix of the
      // new child's stream, and carrying it makes the first fragment garbage.
      this.splitter = new Fmp4BoxSplitter()
      this.activeHwAccel = null
      await this.spawnAttempt(null)
    }
  }

  /** The backend the child ACTUALLY ran with — `null` for software. */
  activeDecodeHwAccel(): string | null {
    const value = this.activeHwAccel
    return value === null || value === 'none' || value === 'copy' ? null : value
  }

  /** Kill ffmpeg and end the plane. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.killChild()
    this.args.plane.end('the fragment child stopped')
  }

  // ── internals ──────────────────────────────────────────────────────────

  private spawnAttempt(decodeHwAccel: string | null): Promise<void> {
    const args = buildFfmpegArgs({
      ...this.args.invocation,
      decodeHwAccel,
      sink: {
        kind: 'stdout',
        container: 'mp4',
        fragmentMs: this.args.fragmentMs,
      },
    })
    this.deps.logger.info('fmp4 fragment child: spawning ffmpeg', {
      tags: { deviceId: this.args.deviceId },
      meta: {
        sourceId: this.args.sourceId,
        fragmentMs: this.args.fragmentMs,
        decodeHwAccel: decodeHwAccel ?? 'software',
        // Once, in full, so a child producing nothing can be diagnosed without
        // another round trip to the host.
        argv: args.join(' '),
      },
    })

    return new Promise<void>((resolve, reject) => {
      const child = this.deps.spawnFn(this.deps.ffmpegBinaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      let settled = false
      /**
       * This attempt FAILED. Set before the kill, because SIGTERM makes the
       * child exit and that exit must not be reported as a death: the retry —
       * or the caller's rejection — already owns what happens next. Without it
       * the timeout path ends the plane the software retry is about to fill,
       * and the consumer sees a stream that stopped for no reason. A "which
       * spawn is current" counter does NOT cover this: the retry has not been
       * spawned when the kill's exit arrives.
       */
      let failed = false
      /**
       * This attempt is still the live producer: it has not failed (a failure
       * hands ownership to the retry, or to the caller's rejection) and nothing
       * has stopped the child. Those two cover every way an attempt stops being
       * current — `start` only respawns after a rejection.
       */
      const isCurrent = (): boolean => !this.stopped && !failed

      const timeoutMs = this.deps.firstUnitTimeoutMs ?? DEFAULT_FIRST_UNIT_TIMEOUT_MS
      const settle = (fail?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (fail) {
          failed = true
          reject(fail)
        } else {
          resolve()
        }
      }

      const timer = setTimeout(() => {
        // `settle` first, `killChild` second: the kill's exit event must find
        // an attempt already marked failed.
        settle(new Error(`fmp4 fragment child: no fragment within ${timeoutMs}ms`))
        this.killChild()
      }, timeoutMs)
      timer.unref?.()

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const unit of this.splitter.push(chunk)) {
          this.unitsOut += 1
          this.args.plane.publish(unit)
          if (unit.kind === 'init') {
            this.deps.logger.info('fmp4 fragment child: INIT segment cut', {
              tags: { deviceId: this.args.deviceId },
              meta: { sourceId: this.args.sourceId, bytes: unit.data.length },
            })
            settle()
          } else if (this.unitsOut % FRAGMENT_LOG_EVERY === 0) {
            this.deps.logger.info('fmp4 fragment child: fragments still flowing', {
              tags: { deviceId: this.args.deviceId },
              meta: {
                sourceId: this.args.sourceId,
                unitsOut: this.unitsOut,
                bytes: unit.data.length,
                subscribers: this.args.plane.subscriberCount,
              },
            })
          }
        }
        const fault = this.splitter.fault
        if (fault !== null) this.onFault(fault, settled, isCurrent(), settle)
      })

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (line: string) => {
        this.deps.logger.debug('fmp4 fragment child ffmpeg', {
          tags: { deviceId: this.args.deviceId },
          meta: { sourceId: this.args.sourceId, line: line.trim() },
        })
      })

      child.once('error', (err: Error) => {
        if (!settled) {
          settle(err)
          return
        }
        if (!isCurrent()) return
        this.args.plane.end('the fragment child errored')
        this.deps.onChildExit?.(err)
      })

      child.once('exit', (code, signal) => {
        if (!settled) {
          settle(
            new Error(
              `fmp4 fragment child: ffmpeg exited before any fragment (code=${code} signal=${signal})`,
            ),
          )
          return
        }
        // A deliberate `stop()` is not a death, and neither is the hardware
        // attempt the software retry already replaced.
        if (!isCurrent()) return
        const error = new Error(
          `fmp4 fragment child: ffmpeg exited while live (code=${code} signal=${signal})`,
        )
        this.deps.logger.warn('fmp4 fragment child: ffmpeg exited while live', {
          tags: { deviceId: this.args.deviceId },
          meta: {
            sourceId: this.args.sourceId,
            code,
            signal,
            unitsOut: this.unitsOut,
          },
        })
        // The consumers' generators must COMPLETE rather than hang on a
        // producer that no longer exists — that hang is what the delegate would
        // report to iOS as a stream that never sets `isLast`.
        this.args.plane.end('the fragment child exited')
        this.deps.onChildExit?.(error)
      })
    })
  }

  /**
   * The byte stream stopped being splittable. Not recoverable — the splitter
   * cannot resynchronise mid-box — so the child is a corpse and every consumer
   * has to be told, loudly, with the reason.
   */
  private onFault(
    reason: string,
    wasLive: boolean,
    current: boolean,
    settle: (fail?: Error) => void,
  ): void {
    const error = new Error(`fmp4 fragment child: ${reason}`)
    this.deps.logger.error('fmp4 fragment child: the ffmpeg output stopped parsing as fMP4', {
      tags: { deviceId: this.args.deviceId },
      meta: {
        sourceId: this.args.sourceId,
        unitsOut: this.unitsOut,
        interstitial: this.splitter.discardedInterstitialTypes,
        reason,
      },
    })
    this.killChild()
    // Before the first unit this is the START failing and `start` decides
    // whether to retry; after it, the child is a corpse and every consumer has
    // to be released rather than left parked on a producer that is gone.
    settle(error)
    if (wasLive && current) {
      this.args.plane.end('the fragment child produced unsplittable output')
      this.deps.onChildExit?.(error)
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM')
      } catch (err) {
        this.deps.logger.warn('fmp4 fragment child: kill error', {
          tags: { deviceId: this.args.deviceId },
          meta: { sourceId: this.args.sourceId, error: errMsg(err) },
        })
      }
    }
  }
}
