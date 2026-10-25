/**
 * `LlmVisionJudge` — showing a picture to a model and getting a typed answer,
 * once, for every caller that does it.
 *
 * `NcConfirmGate` and `SceneConfirmGate` were the same 200 lines twice: the same
 * downscale, the same per-device chain, the same `Promise.race` timeout, the
 * same permissive parse. `SceneConfirmGate`'s own header said it was copied
 * "field by field" from the other with one inversion. This is that mechanism,
 * and the inversion is a parameter.
 *
 * ## The fail direction is the whole point
 *
 * The two gates disagree about what NO ANSWER means, and both are right:
 *
 *  - a notification fails **OPEN**. A cold model must never silence an alarm,
 *    so an unjudged notification ships. The cost of the opposite is a break-in
 *    nobody was told about.
 *  - a scene latch fails **CLOSED**. A latch is a durable claim with state, and
 *    committing an unjudged flip is a claim that cannot be retracted. The
 *    periodic floor re-proposes the same flip a minute later, so holding loses
 *    nothing.
 *
 * So the judge does not decide; it computes `proceed` from the direction it was
 * configured with, and each gate keeps its own verdict shape and counters. A
 * per-call `overrideProceed` is the operator's row-level inversion
 * (`onTimeout: 'suppress'` on a notification, `onTimeout: 'flip'` on a scene).
 *
 * ## What it does NOT own
 *
 * The prompts. Each caller's system turn is a product decision about what the
 * model is being asked, and the hardening sentence differs in wording between
 * them for good reason. The judge takes the prompt; it never composes one.
 */
import { randomUUID } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'
import type { z } from 'zod'
import { parseModelJson } from './parse-model-json.js'

/** Why there is no answer. Each is a DIFFERENT remedy, so each has a name. */
export type JudgeFailure = 'no-image' | 'busy' | 'timeout' | 'error' | 'unparseable'

export type FailDirection = 'open' | 'closed'

export interface JudgeOk<T> {
  readonly ok: true
  readonly value: T
  readonly model: string | undefined
  readonly latencyMs: number
}

export interface JudgeNoAnswer {
  readonly ok: false
  readonly failure: JudgeFailure
  readonly reason: string
  /**
   * Does the action the caller was gating GO AHEAD anyway?
   *
   * `true` for a fail-open gate, `false` for a fail-closed one, inverted when
   * the operator set the override on the row. The caller reads this instead of
   * re-deriving the policy, which is how the two gates stay two configurations
   * rather than drifting back into two implementations.
   */
  readonly proceed: boolean
  readonly latencyMs: number
}

export type JudgeOutcome<T> = JudgeOk<T> | JudgeNoAnswer

/** One picture on its way to a model. */
export interface JudgeImage {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mimeType: string
}

export interface JudgeVisionRequest {
  readonly profileId?: string
  /** Minted per call so the judge can STOP this generation, not just stop
   *  waiting for it. */
  readonly requestId: string
  readonly consumer: string
  readonly system: string
  readonly prompt: string
  /**
   * The pictures, in the order the prompt refers to them. Never empty — a call
   * with nothing to look at is refused before it reaches here.
   *
   * PLURAL because the count is a property of the CALLER, not of the judge: a
   * confirm gate asks about one frame, a digest asks one JOINT question about
   * up to `maxAiImages` of them, and asking a joint question one frame at a
   * time answers a different question. `llm.generateVision` has always taken a
   * list; the judge was the only thing narrowing it to one.
   */
  readonly images: readonly JudgeImage[]
  readonly jsonSchema: Record<string, unknown>
  readonly temperature: number
  /**
   * The caller's bound, handed to the PROVIDER rather than only used to race
   * it here. `llm.generateVision` has always accepted a per-call override of
   * `profile.timeoutMs`; without passing one, the judge stopped waiting at its
   * bound while the generation ran on to the profile's 60 s. A summary that
   * asks for 180 s then got 60 — and its digest shipped without a sentence.
   *
   * The external race stays: it is the backstop for a provider that never
   * answers at all, and the only path that can CANCEL the generation.
   */
  readonly timeoutMs?: number
}

/** Loose on purpose: the cap answers a discriminated union, the two gates
 *  historically adapted it differently, and both shapes land here. */
export interface JudgeVisionResult {
  readonly ok: boolean
  readonly text?: string
  readonly model?: string
  readonly code?: string
  readonly message?: string
}

export interface VisionJudgeDeps {
  readonly logger: IScopedLogger
  /** `ctx.api.llm.generateVision`, adapted to the singular-image shape. */
  readonly generateVision: (request: JudgeVisionRequest) => Promise<JudgeVisionResult>
  /**
   * `ctx.api.llm.cancel`. Optional so a caller can be wired without it, but its
   * absence is the ORPHAN case: the judge stops waiting at its bound while the
   * generation runs on to the profile timeout, and the per-camera bound then
   * counts waits rather than generations.
   */
  readonly cancelVision?: (requestId: string) => Promise<void>
  /** Longest-edge downscale. Injected so the bound is testable without sharp. */
  readonly downscale: (
    bytes: Uint8Array<ArrayBuffer>,
    maxPx: number,
  ) => Promise<Uint8Array<ArrayBuffer>>
  readonly now?: () => number
}

export interface VisionJudgeConfig {
  /** Usage tag every call is billed under (`llm.getUsage`). */
  readonly consumer: string
  /** What NO ANSWER means for this caller. */
  readonly failDirection: FailDirection
  /** One call in flight, `maxPendingPerDevice - 1` queued. */
  readonly maxPendingPerDevice: number
}

export interface JudgeCall<T> {
  readonly deviceId: number
  /**
   * The pictures this one question is about. EMPTY = nothing to judge, and it
   * still goes through the fail direction rather than throwing — a digest whose
   * every tile lost its media is exactly as unjudgeable as a notification whose
   * attachment never resolved, and both must reach their configured outcome.
   */
  readonly images: readonly JudgeImage[]
  readonly profileId?: string
  readonly system: string
  readonly prompt: string
  readonly jsonSchema: Record<string, unknown>
  readonly answerSchema: z.ZodType<T>
  readonly maxImagePx: number
  readonly timeoutMs: number
  /** Row-level inversion of {@link VisionJudgeConfig.failDirection}. */
  readonly overrideProceed?: boolean
  /** Merged into every log line so a per-camera question stays answerable. */
  readonly logMeta: Record<string, unknown>
}

/**
 * One call in flight per device, the rest queued, the overflow refused.
 *
 * A busy camera against a single-threaded local model is the case this exists
 * for: without it, ten frames of one driveway queue ten generations and the
 * eleventh notification waits behind all of them.
 */
class PerDeviceQueue {
  private readonly chain = new Map<number, Promise<void>>()
  private readonly pending = new Map<number, number>()

  constructor(private readonly maxPending: number) {}

  depth(deviceId: number): number {
    return this.pending.get(deviceId) ?? 0
  }

  isFull(deviceId: number): boolean {
    return this.depth(deviceId) >= this.maxPending
  }

  async run<T>(deviceId: number, work: () => Promise<T>): Promise<T> {
    this.pending.set(deviceId, this.depth(deviceId) + 1)
    const previous = this.chain.get(deviceId) ?? Promise.resolve()
    let release = (): void => undefined
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    this.chain.set(
      deviceId,
      previous.then(() => mine),
    )
    try {
      await previous
      return await work()
    } finally {
      release()
      const left = this.depth(deviceId) - 1
      if (left <= 0) {
        this.pending.delete(deviceId)
        this.chain.delete(deviceId)
      } else {
        this.pending.set(deviceId, left)
      }
    }
  }
}

/** Race a call against a bound. `'timeout'` means the timer won. */
async function raceTimeout<T>(call: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<T | 'timeout'>([
      call,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Longest-edge downscale via sharp.
 *
 * 448 px is not arbitrary: it is the native tile size of the vision encoders
 * these models use, so a larger image costs tokens and latency without adding
 * detail the encoder can see.
 */
export async function downscaleJpeg(
  bytes: Uint8Array<ArrayBuffer>,
  maxPx: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const { default: sharp } = await import('sharp')
  const out = await sharp(Buffer.from(bytes))
    .resize({
      width: maxPx,
      height: maxPx,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer()
  const copy = new Uint8Array(out.byteLength)
  copy.set(out)
  return copy
}

export class LlmVisionJudge {
  private readonly now: () => number
  private readonly queue: PerDeviceQueue

  constructor(
    private readonly deps: VisionJudgeDeps,
    private readonly config: VisionJudgeConfig,
  ) {
    this.now = deps.now ?? ((): number => Date.now())
    this.queue = new PerDeviceQueue(config.maxPendingPerDevice)
  }

  async judge<T>(call: JudgeCall<T>): Promise<JudgeOutcome<T>> {
    const startedAt = this.now()
    if (call.images.length === 0) {
      return this.noAnswer(call, 'no-image', 'no image resolved', startedAt)
    }
    if (this.queue.isFull(call.deviceId)) {
      return this.noAnswer(
        call,
        'busy',
        `${String(this.queue.depth(call.deviceId))} judgements already pending for this camera`,
        startedAt,
      )
    }
    return this.queue.run(call.deviceId, () => this.run(call, startedAt))
  }

  private async run<T>(call: JudgeCall<T>, startedAt: number): Promise<JudgeOutcome<T>> {
    if (call.images.length === 0) {
      return this.noAnswer(call, 'no-image', 'no image resolved', startedAt)
    }

    // A failed resize costs THAT IMAGE's bytes, never the verdict and never the
    // other images — the model reads a full-size frame perfectly well, it just
    // costs latency and tokens.
    const images: JudgeImage[] = []
    for (const image of call.images) {
      const bytes = await this.deps
        .downscale(image.bytes, call.maxImagePx)
        .catch((err: unknown): Uint8Array<ArrayBuffer> => {
          this.deps.logger.warn('vision judge could not downscale — judging the full-size image', {
            tags: { deviceId: call.deviceId },
            meta: {
              ...call.logMeta,
              maxPx: call.maxImagePx,
              error: String(err),
            },
          })
          return image.bytes
        })
      images.push({ bytes, mimeType: image.mimeType })
    }

    const requestId = randomUUID()
    const raced = await raceTimeout(
      this.deps
        .generateVision({
          ...(call.profileId !== undefined ? { profileId: call.profileId } : {}),
          requestId,
          consumer: this.config.consumer,
          system: call.system,
          prompt: call.prompt,
          images,
          jsonSchema: call.jsonSchema,
          // Judging is not creative writing. Pinned per call, whatever the
          // profile says, because a verdict that varies run to run is not one.
          temperature: 0,
          timeoutMs: call.timeoutMs,
        })
        // A cap client that THROWS is still a no-answer, not a crash in the
        // notification path. One gate defended against this and the other did
        // not; now neither has to remember.
        .catch(
          (err: unknown): JudgeVisionResult => ({
            ok: false,
            message: String(err),
          }),
        ),
      call.timeoutMs,
    )

    if (raced === 'timeout') {
      // STOP the generation, do not merely stop waiting for it. Without this the
      // slot is freed here while the model keeps working upstream, so a busy
      // camera can have more generations in flight than the bound believes.
      // Cancelling is best-effort and never changes the verdict.
      await this.deps.cancelVision?.(requestId).catch((err: unknown) => {
        this.deps.logger.debug('vision judge could not cancel a timed-out generation', {
          tags: { deviceId: call.deviceId },
          meta: { ...call.logMeta, requestId, error: String(err) },
        })
      })
      return this.noAnswer(
        call,
        'timeout',
        `no verdict within ${String(call.timeoutMs)}ms`,
        startedAt,
      )
    }
    if (!raced.ok) {
      const reason =
        raced.code === 'no-profile'
          ? 'no vision profile configured'
          : (raced.message ?? `llm unavailable (${raced.code ?? 'unknown'})`)
      return this.noAnswer(call, 'error', reason, startedAt)
    }

    const text = raced.text ?? ''
    const value = parseModelJson(text, call.answerSchema)
    if (value === null) {
      return this.noAnswer(
        call,
        'unparseable',
        `model answered outside the schema: ${text.slice(0, 120)}`,
        startedAt,
      )
    }
    return {
      ok: true,
      value,
      model: raced.model,
      latencyMs: this.now() - startedAt,
    }
  }

  /**
   * The fail direction, applied in ONE place.
   *
   * Note what is NOT here: a log line. The caller logs, because only the caller
   * knows whether this outcome delivered a notification or held a latch, and a
   * line that cannot say which is a line nobody can act on.
   */
  private noAnswer<T>(
    call: JudgeCall<T>,
    failure: JudgeFailure,
    reason: string,
    startedAt: number,
  ): JudgeNoAnswer {
    return {
      ok: false,
      failure,
      reason,
      proceed: call.overrideProceed ?? this.config.failDirection === 'open',
      latencyMs: this.now() - startedAt,
    }
  }
}
