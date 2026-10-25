/**
 * AI-vision pre-annotation — the request a vision LLM is sent, the answer it
 * may give back, and whether the frame leaves the house to get it.
 *
 * Pure: no I/O, no cap client. `retrain-llm-service.ts` does the calling.
 *
 * ## The answer is untrusted input
 *
 * A language model asked for JSON may answer with prose, with a code fence,
 * with a box in pixels, with a class nobody asked for, or with a review of a
 * box that was never sent. So the answer is parsed against a STRICT shape:
 *
 * - the whole answer must be `{ objects: [...], reviews: [...] }` and nothing
 *   else, or it is refused as malformed — a half-understood answer is not
 *   salvaged;
 * - each object and each review is then checked on its own; one that fails
 *   (a box outside the frame, an unasked class, a score outside [0,1], a
 *   review of an unknown ref) is DROPPED and COUNTED, never clamped into a
 *   plausible-looking box.
 *
 * What survives becomes drafts and flags on the canvas — nothing is accepted
 * for the operator (D790).
 *
 * ## Where the frame goes
 *
 * {@link llmProfileLeavesHouse} is the one rule the page and the server agree
 * on: a cloud vendor always leaves the house; a local runtime never does; an
 * OpenAI-compatible endpoint leaves unless its host is loopback, a private
 * (RFC 1918 / ULA / link-local) address, a `.local` name or a bare host name.
 * An endpoint that cannot be judged is treated as leaving — the safe answer.
 */

import type { RetrainMacroClass } from '@camstack/types'
import { z } from 'zod'
import { isRetrainMacroClass } from './retrain-taxonomy.js'

/** The profile facts the privacy rule reads. */
export interface LlmProfileLocality {
  readonly kind: string
  readonly baseUrl?: string
}

const ALWAYS_LOCAL_KINDS: ReadonlySet<string> = new Set(['managed-local', 'apple-foundation'])
const ALWAYS_CLOUD_KINDS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'google'])

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false
  }
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT / tailnet
  )
}

function isLocalHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
  if (host.includes(':')) {
    // IPv6: loopback, unique-local (fc00::/7) or link-local (fe80::/10).
    return (
      host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
    )
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan')) return true
  if (isPrivateIpv4(host)) return true
  // A bare name ("mac-mini") resolves on the LAN only.
  return !host.includes('.') && !host.includes(':')
}

/** Does sending a frame to this profile send it outside the house? */
export function llmProfileLeavesHouse(profile: LlmProfileLocality): boolean {
  if (ALWAYS_LOCAL_KINDS.has(profile.kind)) return false
  if (ALWAYS_CLOUD_KINDS.has(profile.kind)) return true
  if (profile.baseUrl === undefined || profile.baseUrl === '') return true
  try {
    return !isLocalHost(new URL(profile.baseUrl).hostname)
  } catch {
    return true
  }
}

/** A box on the canvas the model is asked to review, by ref. */
export interface LlmReviewBox {
  readonly ref: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly macroClass: RetrainMacroClass
  readonly label?: string
}

export interface LlmAssistRequest {
  readonly system: string
  readonly prompt: string
  readonly jsonSchema: Record<string, unknown>
}

/** At most this many boxes are sent for review — a prompt, not a dump. */
const LLM_REVIEW_MAX_BOXES = 50

const VERDICTS = ['confirmed', 'wrong-class', 'not-an-object', 'uncertain'] as const
export type LlmVerdict = (typeof VERDICTS)[number]

const SYSTEM_PROMPT = [
  'You annotate frames from home security cameras to build an object-detection training set.',
  'Be precise and conservative: only report what is clearly visible.',
  'Coordinates are normalised to the full frame: x and y are the top-left corner,',
  'w and h the width and height, all between 0 and 1.',
  'Answer with JSON only, exactly in the requested schema, with no other text.',
].join(' ')

/** The JSON schema asked of the model (and enforced again by the parser). */
function answerJsonSchema(classes: readonly RetrainMacroClass[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['objects', 'reviews'],
    properties: {
      objects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['class', 'box', 'confidence', 'reason'],
          properties: {
            class: { type: 'string', enum: [...classes] },
            label: { type: 'string' },
            box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
          },
        },
      },
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'verdict', 'reason'],
          properties: {
            ref: { type: 'string' },
            verdict: { type: 'string', enum: [...VERDICTS] },
            suggestedClass: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/** Build the request: target classes, the frame size, the boxes to review. */
export function buildLlmAssistRequest(input: {
  readonly classes: readonly RetrainMacroClass[]
  readonly width: number
  readonly height: number
  readonly boxes: readonly LlmReviewBox[]
}): LlmAssistRequest {
  const boxes = input.boxes.slice(0, LLM_REVIEW_MAX_BOXES).map((b) =>
    JSON.stringify({
      ref: b.ref,
      class: b.macroClass,
      ...(b.label !== undefined ? { label: b.label } : {}),
      box: [round(b.bbox.x), round(b.bbox.y), round(b.bbox.w), round(b.bbox.h)],
    }),
  )
  const prompt = [
    `The image is one camera frame, ${String(input.width)}×${String(input.height)} pixels.`,
    `1. List every object of these classes you can see: ${input.classes.join(', ')}.`,
    '   For each give class, an optional free-text label (e.g. "van", "postman"),',
    '   box [x, y, w, h] normalised to the frame, confidence 0–1, and a short reason.',
    '   Include small and partly hidden ones; do not include anything else.',
    boxes.length > 0
      ? `2. Review these existing boxes. For each ref say "confirmed", "wrong-class" (with suggestedClass), "not-an-object" or "uncertain", with a short reason:\n${boxes.join('\n')}`
      : '2. There are no existing boxes to review: answer "reviews": [].',
    'Answer with JSON: {"objects": [...], "reviews": [...]}.',
  ].join('\n')
  return { system: SYSTEM_PROMPT, prompt, jsonSchema: answerJsonSchema(input.classes) }
}

/** One object the model reported, after validation. */
export interface LlmObject {
  readonly macroClass: RetrainMacroClass
  readonly label?: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly confidence: number
  readonly reason: string
}

/** One review of a box that was sent. */
export interface LlmReview {
  readonly ref: string
  readonly verdict: LlmVerdict
  readonly suggestedClass?: RetrainMacroClass
  readonly reason: string
}

export type LlmAssistParse =
  | {
      readonly kind: 'parsed'
      readonly objects: readonly LlmObject[]
      readonly reviews: readonly LlmReview[]
      /** Items dropped for failing their own check. */
      readonly rejected: number
    }
  | { readonly kind: 'malformed'; readonly detail: string }

/** The whole answer: two arrays and nothing else. Items are checked one by one. */
const AnswerSchema = z.strictObject({
  objects: z.array(z.unknown()),
  reviews: z.array(z.unknown()),
})

const ObjectSchema = z.strictObject({
  class: z.string(),
  label: z.string().optional(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
})

const ReviewSchema = z.strictObject({
  ref: z.string(),
  verdict: z.enum(VERDICTS),
  suggestedClass: z.string().optional(),
  reason: z.string().max(500),
})

/** Rounding slack on the frame edge before a box counts as outside it. */
const EDGE_SLACK = 0.01

function frameBox(box: readonly [number, number, number, number]): LlmObject['bbox'] | null {
  const [x, y, w, h] = box
  if (![x, y, w, h].every(Number.isFinite)) return null
  if (!(w > 0) || !(h > 0) || x < -EDGE_SLACK || y < -EDGE_SLACK) return null
  if (x + w > 1 + EDGE_SLACK || y + h > 1 + EDGE_SLACK) return null
  const cx = Math.max(0, x)
  const cy = Math.max(0, y)
  return { x: cx, y: cy, w: Math.min(w, 1 - cx), h: Math.min(h, 1 - cy) }
}

/** Strip a Markdown code fence a model wrapped its JSON in. */
function unfence(text: string): string {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed)
  return fence?.[1] !== undefined ? fence[1].trim() : trimmed
}

/** A free-text label, never a macro word (the tier rule). */
function usableLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return isRetrainMacroClass(trimmed.toLowerCase()) ? undefined : trimmed
}

/** Parse the model's answer. See the module header for the rules. */
export function parseLlmAssistAnswer(
  text: string,
  expected: { readonly classes: readonly RetrainMacroClass[]; readonly refs: ReadonlySet<string> },
): LlmAssistParse {
  let raw: unknown
  try {
    raw = JSON.parse(unfence(text))
  } catch {
    return { kind: 'malformed', detail: 'the answer is not JSON' }
  }
  const answer = AnswerSchema.safeParse(raw)
  if (!answer.success) {
    return { kind: 'malformed', detail: 'the answer is not {"objects": [...], "reviews": [...]}' }
  }
  const asked = new Set<string>(expected.classes)
  let rejected = 0
  const objects: LlmObject[] = []
  for (const item of answer.data.objects) {
    const parsed = ObjectSchema.safeParse(item)
    const cls = parsed.success ? parsed.data.class.trim().toLowerCase() : ''
    const bbox = parsed.success ? frameBox(parsed.data.box) : null
    if (!parsed.success || bbox === null || !asked.has(cls) || !isRetrainMacroClass(cls)) {
      rejected += 1
      continue
    }
    const label = usableLabel(parsed.data.label)
    objects.push({
      macroClass: cls,
      ...(label !== undefined ? { label } : {}),
      bbox,
      confidence: parsed.data.confidence,
      reason: parsed.data.reason,
    })
  }
  const reviews: LlmReview[] = []
  for (const item of answer.data.reviews) {
    const parsed = ReviewSchema.safeParse(item)
    if (!parsed.success || !expected.refs.has(parsed.data.ref)) {
      rejected += 1
      continue
    }
    const suggested = parsed.data.suggestedClass?.trim().toLowerCase()
    reviews.push({
      ref: parsed.data.ref,
      verdict: parsed.data.verdict,
      ...(suggested !== undefined && isRetrainMacroClass(suggested)
        ? { suggestedClass: suggested }
        : {}),
      reason: parsed.data.reason,
    })
  }
  return { kind: 'parsed', objects, reviews, rejected }
}
