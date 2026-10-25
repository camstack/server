/**
 * The node-side `completeApple`: an `LlmRuntimeAppleCompleteInput` in, an
 * `LlmGenerateResult` out, through the supervised helper.
 *
 * It gates only on STATIC facts (not a Mac, a macOS older than 26): never on
 * the availability mirror, which is a fallible read (D49). The helper checks
 * Apple's own availability on every generation and answers `unavailable` with
 * the reason itself.
 *
 * Text only: images are REFUSED (`unavailable`) until a helper built against a
 * macOS 27 SDK reports image input — never dropped to answer a picture
 * question with prose about no picture.
 */
import type {
  AppleFmAvailability,
  IScopedLogger,
  LlmGenerateResult,
  LlmRuntimeAppleCompleteInput,
} from '@camstack/types'
import type { HelperOutcome, HelperRequestOptions } from './afm-helper.js'
import {
  type AfmGenerateRequest,
  AfmGenerateReplySchema,
  APPLE_SYSTEM_MODEL,
} from './afm-protocol.js'

/** The profile's timeout is threaded by the hub; this is the floor if it is not. */
const DEFAULT_APPLE_TIMEOUT_MS = 60_000
const CANCELLED: LlmGenerateResult = {
  ok: false,
  code: 'timeout',
  message: 'the call was cancelled',
}

export interface AppleGenerateHelper {
  request(payload: AfmGenerateRequest, opts: HelperRequestOptions): Promise<HelperOutcome>
}

export interface AppleAvailabilitySource {
  current(): AppleFmAvailability
  /** A known absence answerable without the helper; `null` = ask the helper. */
  staticAbsence(): AppleFmAvailability | null
}

export interface AppleFmBackendDeps {
  readonly nodeId: string
  readonly helper: AppleGenerateHelper
  readonly availability: AppleAvailabilitySource
  readonly logger: IScopedLogger
}

export interface AppleFmBackend {
  availability(): AppleFmAvailability
  complete(input: LlmRuntimeAppleCompleteInput, signal: AbortSignal): Promise<LlmGenerateResult>
}

function toRequest(input: LlmRuntimeAppleCompleteInput): AfmGenerateRequest {
  return {
    op: 'generate',
    prompt: input.prompt,
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.jsonSchema !== undefined ? { jsonSchema: input.jsonSchema } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { topP: input.topP } : {}),
    ...(input.topK !== undefined ? { topK: input.topK } : {}),
  }
}

function fromOutcome(outcome: HelperOutcome, nodeId: string): LlmGenerateResult {
  switch (outcome.kind) {
    case 'timeout':
      return {
        ok: false,
        code: 'timeout',
        message: `Apple Foundation Models on ${nodeId} timed out`,
      }
    case 'cancelled':
      return CANCELLED
    case 'busy':
      return {
        ok: false,
        code: 'rate-limited',
        message: `Apple Foundation Models on ${nodeId} is at its concurrent-generation bound`,
      }
    case 'crashed':
      return {
        ok: false,
        code: 'unavailable',
        message: `the Apple helper on ${nodeId} crashed: ${outcome.detail}`,
      }
    case 'unavailable':
      return { ok: false, code: 'unavailable', message: `${outcome.reason}: ${outcome.detail}` }
    case 'reply': {
      const parsed = AfmGenerateReplySchema.safeParse(outcome.reply)
      if (!parsed.success) {
        return {
          ok: false,
          code: 'adapter-error',
          message: 'the Apple helper answered a shape this addon cannot read',
        }
      }
      const reply = parsed.data
      if (reply.ok) {
        return {
          ok: true,
          text: reply.text,
          model: APPLE_SYSTEM_MODEL,
          usage: reply.usage,
          truncated: reply.truncated,
          latencyMs: reply.latencyMs,
        }
      }
      if (reply.code === 'cancelled') return CANCELLED
      return {
        ok: false,
        code: reply.code,
        message: reply.message,
        ...(reply.refusalSource !== undefined ? { refusalSource: reply.refusalSource } : {}),
      }
    }
  }
}

export function createAppleFmBackend(deps: AppleFmBackendDeps): AppleFmBackend {
  return {
    availability: () => deps.availability.current(),

    complete: async (input, signal) => {
      const meta = { nodeId: deps.nodeId, consumer: input.consumer, requestId: input.requestId }
      const absence = deps.availability.staticAbsence()
      if (absence !== null) {
        deps.logger.info('apple fm generation refused: not available on this node', {
          meta: { ...meta, state: absence.state },
        })
        return {
          ok: false,
          code: 'unavailable',
          message: `Apple Foundation Models cannot run on ${deps.nodeId} (${absence.state})`,
        }
      }
      if (input.images !== undefined && input.images.length > 0) {
        deps.logger.info('apple fm generation refused: images on a text-only model', {
          meta: { ...meta, imageCount: input.images.length },
        })
        return {
          ok: false,
          code: 'unavailable',
          message: `Apple Foundation Models on ${deps.nodeId} has no image input`,
        }
      }
      const outcome = await deps.helper.request(toRequest(input), {
        timeoutMs: input.timeoutMs ?? DEFAULT_APPLE_TIMEOUT_MS,
        signal,
        counted: true,
      })
      const result = fromOutcome(outcome, deps.nodeId)
      if (!result.ok) {
        if (result.refusalSource === 'guardrail') {
          deps.logger.warn('apple fm guardrail refused a generation', {
            meta: { ...meta, message: result.message },
          })
        } else {
          deps.logger.info('apple fm generation failed', {
            meta: { ...meta, code: result.code, message: result.message, outcome: outcome.kind },
          })
        }
      }
      return result
    },
  }
}
