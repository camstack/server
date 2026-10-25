/**
 * RetrainLlmAssistService — AI-vision pre-annotation through the existing
 * `llm` capability (addon-ai: profiles in `ai:llm-profiles`, the hub `llm`
 * provider fanning to a node's runtime or a vendor API).
 *
 * One frame per call, at human speed: the copy the operator is looking at
 * (the same pixels the export ships, so a proposed box lands in the right
 * space), the target classes, and every box already on the canvas by ref so
 * the model can confirm or flag them ("this 'person' is a plant"). The answer
 * is parsed strictly (`retrain-llm-assist.ts`) and comes back as drafts and
 * reviews — nothing is stored here and nothing is accepted for the operator.
 *
 * ## The frame leaving the house is the operator's decision, every time
 *
 * A profile that sends the frame outside (`llmProfileLeavesHouse`) is
 * refused unless the call carries `allowCloud: true`, which the page sets only
 * after the operator confirmed that run. The check is HERE as well as in the
 * page: a page bug must not be able to ship a camera frame to a vendor.
 *
 * Nothing logged carries the image, the prompt or the answer text — the
 * profile, the counts and the outcome only.
 */

import type { IScopedLogger, RetrainLlmAssistResult, RetrainMacroClass } from '@camstack/types'
import type { RetrainFrameStore } from './retrain-frame-store.js'
import { proposalOrigin } from './retrain-origin.js'
import {
  buildLlmAssistRequest,
  type LlmReviewBox,
  llmProfileLeavesHouse,
  parseLlmAssistAnswer,
} from './retrain-llm-assist.js'

/** The profile facts this service reads from `llm.listProfiles`. */
export interface LlmProfileView {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly kind: string
  readonly baseUrl?: string
  readonly enabled: boolean
  readonly supportsVision: boolean
}

export interface LlmVisionRequest {
  readonly profileId: string
  readonly system: string
  readonly prompt: string
  readonly jsonSchema: Record<string, unknown>
  readonly image: Buffer
}

export type LlmVisionResult =
  | { readonly ok: true; readonly text: string; readonly model: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The `llm` cap surface, injected so no test ever calls a model. */
export interface RetrainLlmPort {
  readonly listProfiles: () => Promise<readonly LlmProfileView[]>
  readonly generateVision: (request: LlmVisionRequest) => Promise<LlmVisionResult>
}

/** The usage tag every AI-assist call is counted under (`llm.getUsage`). */
export const RETRAIN_LLM_CONSUMER = 'retrain-assist'

/** One frame, one answer: a cold local vision model can take a minute. */
export const RETRAIN_LLM_TIMEOUT_MS = 150_000

export interface RetrainLlmAssistDeps {
  readonly frames: RetrainFrameStore
  readonly llm: RetrainLlmPort
  readonly logger: IScopedLogger
}

/** A vision profile the page may offer, and where it sends the frame. */
export interface RetrainAssistProfileView {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly kind: string
  readonly leavesHouse: boolean
}

export interface RetrainLlmAssistRequest {
  readonly deviceId: number
  readonly trackId?: string
  readonly frameId: string
  readonly profileId: string
  readonly classes: readonly RetrainMacroClass[]
  readonly boxes: readonly LlmReviewBox[]
  /** The operator confirmed this run may send the frame outside the house. */
  readonly allowCloud: boolean
}

export class RetrainLlmAssistService {
  private readonly deps: RetrainLlmAssistDeps

  constructor(deps: RetrainLlmAssistDeps) {
    this.deps = deps
  }

  /** The enabled, vision-capable profiles — a text-only one would be refused. */
  async listProfiles(): Promise<readonly RetrainAssistProfileView[]> {
    const profiles = await this.deps.llm.listProfiles()
    return profiles
      .filter((p) => p.enabled && p.supportsVision)
      .map((p) => ({
        id: p.id,
        name: p.name,
        model: p.model,
        kind: p.kind,
        leavesHouse: llmProfileLeavesHouse(p),
      }))
  }

  async propose(input: RetrainLlmAssistRequest): Promise<RetrainLlmAssistResult> {
    const tags = { deviceId: input.deviceId }
    const frame = await this.deps.frames.get(input.frameId)
    if (
      frame === null ||
      frame.deviceId !== input.deviceId ||
      (input.trackId !== undefined && frame.trackId !== input.trackId)
    ) {
      return { kind: 'refused', reason: 'unknown-frame' }
    }
    const profile = (await this.deps.llm.listProfiles()).find((p) => p.id === input.profileId)
    if (profile === undefined) return { kind: 'refused', reason: 'unknown-profile' }
    if (!profile.enabled) return { kind: 'refused', reason: 'profile-disabled' }
    if (!profile.supportsVision) return { kind: 'refused', reason: 'no-vision' }
    const leavesHouse = llmProfileLeavesHouse(profile)
    if (leavesHouse && !input.allowCloud) {
      this.deps.logger.warn('retrain AI assist refused: a cloud profile without confirmation', {
        tags,
        meta: { frameId: input.frameId, profileId: profile.id },
      })
      return {
        kind: 'refused',
        reason: 'cloud-not-confirmed',
        detail: 'this profile sends the frame outside the house; confirm the run first',
      }
    }
    const bytes = await this.deps.frames.readFrame(frame)
    if (bytes === null) return { kind: 'refused', reason: 'unreadable-frame' }

    const request = buildLlmAssistRequest({
      classes: input.classes,
      width: frame.width,
      height: frame.height,
      boxes: input.boxes,
    })
    const answer = await this.deps.llm.generateVision({
      profileId: profile.id,
      system: request.system,
      prompt: request.prompt,
      jsonSchema: request.jsonSchema,
      image: bytes,
    })
    if (!answer.ok) {
      this.deps.logger.warn('retrain AI assist: the model call failed', {
        tags,
        meta: { frameId: input.frameId, profileId: profile.id, code: answer.code },
      })
      return { kind: 'refused', reason: 'llm-error', detail: `${answer.code}: ${answer.message}` }
    }
    const parsed = parseLlmAssistAnswer(answer.text, {
      classes: input.classes,
      refs: new Set(input.boxes.map((b) => b.ref)),
    })
    if (parsed.kind === 'malformed') {
      this.deps.logger.warn('retrain AI assist: the answer was refused as malformed', {
        tags,
        meta: {
          frameId: input.frameId,
          profileId: profile.id,
          model: answer.model,
          detail: parsed.detail,
          answerChars: answer.text.length,
        },
      })
      return { kind: 'refused', reason: 'malformed-answer', detail: parsed.detail }
    }
    this.deps.logger.info('retrain AI assist proposed boxes', {
      tags,
      meta: {
        frameId: input.frameId,
        profileId: profile.id,
        model: answer.model,
        leftHouse: leavesHouse,
        proposals: parsed.objects.length,
        reviews: parsed.reviews.length,
        rejected: parsed.rejected,
      },
    })
    return {
      kind: 'proposed',
      profileId: profile.id,
      model: answer.model,
      leftHouse: leavesHouse,
      proposals: parsed.objects.map((o, index) => ({
        origin: proposalOrigin('llm', index, {
          bbox: o.bbox,
          macroClass: o.macroClass,
          ...(o.label !== undefined ? { label: o.label } : {}),
          score: o.confidence,
          modelId: answer.model,
        }),
        bbox: o.bbox,
        macroClass: o.macroClass,
        ...(o.label !== undefined ? { label: o.label } : {}),
        kind: 'subject',
        source: 'llm',
        assistModelId: answer.model,
        assistScore: o.confidence,
        reason: o.reason,
      })),
      reviews: parsed.reviews.map((r) => ({
        ref: r.ref,
        verdict: r.verdict,
        ...(r.suggestedClass !== undefined ? { suggestedClass: r.suggestedClass } : {}),
        reason: r.reason,
      })),
      rejected: parsed.rejected,
    }
  }
}
