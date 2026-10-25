/**
 * `debug.tape.*` — the tracking-tape surface (D681, spec §3.3). Admin,
 * hub-local, shipped with one `camstack deploy`, like `debug.*`.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { decodesAsJson } from '../store/tracking-tape-index-store.js'

const TapeStatusRowSchema = z.object({
  deviceId: z.number(),
  state: z.enum(['off', 'recording', 'refused', 'failing', 'unknown']),
  reason: z.string().optional(),
  segmentOriginMs: z.number().optional(),
  framesPerMin: z.number().optional(),
  gapsSinceArmed: z.number(),
  /** `null` when the shelf could not be read — never 0 (D393). */
  segmentsHeld: z.number().nullable(),
  heldFromMs: z.number().optional(),
  heldToMs: z.number().optional(),
  bytesLastHour: z.number().nullable(),
  bytesHeld: z.number().nullable(),
  /** Why the figures above are `null`. */
  shelfError: z.string().optional(),
})

const TapeStatusInputSchema = z.object({ deviceIds: z.array(z.number().int()).optional() })
const TapeStatusOutputSchema = z.object({ cameras: z.array(TapeStatusRowSchema).readonly() })

const TapeLightingInputSchema = z.enum(['day', 'ir'])

/**
 * Free text the settings store would hand back decoded is refused by name
 * (follow-up 102, review M2): whole JSON array/object text in a TEXT column
 * comes back as an array or object, and the index could not read the row.
 */
const NOT_JSON_TEXT =
  'must not be JSON array/object text — the settings store would hand it back decoded'
const notJsonText = (s: string): boolean => !decodesAsJson(s)

export const PromoteInputSchema = z.object({
  deviceId: z.number().int().positive(),
  fromMs: z.number().int(),
  toMs: z.number().int(),
  scenario: z.string().refine(notJsonText, { message: NOT_JSON_TEXT }),
  note: z.string().max(500).refine(notJsonText, { message: NOT_JSON_TEXT }).optional(),
  lighting: TapeLightingInputSchema.optional(),
})
const PromoteOutputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    tapeId: z.string(),
    state: z.enum(['complete', 'incomplete']),
    frames: z.number(),
    gaps: z.number(),
    pinnedTracks: z.number(),
    bytes: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'window-too-long',
      'window-in-future',
      'window-not-recorded',
      'invalid-scenario',
      'promotion-budget',
      'empty-window',
      // The camera's segments could not be listed (or only in part): the
      // window cannot be proved whole, which is not "not recorded" (D393).
      'shelf-unreadable',
      'not-post-processing-node',
      'artifacts-elsewhere',
      // This node may record, but the recorder has not started (or failed to).
      'tapes-not-started',
    ]),
    detail: z.string(),
  }),
])

const TapeListItemSchema = z.object({
  id: z.string(),
  deviceId: z.number(),
  scenario: z.string(),
  note: z.string().nullable(),
  lighting: TapeLightingInputSchema,
  fromMs: z.number(),
  toMs: z.number(),
  state: z.enum(['complete', 'incomplete']),
  frames: z.number(),
  skips: z.number(),
  gaps: z.number(),
  bytes: z.number(),
  reviewed: z.boolean(),
  released: z.boolean(),
  /** The live track ids the window names (spec §3.3). */
  tracks: z.array(z.string()).readonly(),
  tracksStillStored: z.number(),
})
const TapeListInputSchema = z.object({ deviceId: z.number().int().optional() })
const TapeListOutputSchema = z.object({ tapes: z.array(TapeListItemSchema).readonly() })
const TapeIdInputSchema = z.object({ tapeId: z.string().min(1) })
const TapeLaneOutSchema = z.object({
  trackId: z.string(),
  plane: z.enum(['pipeline', 'onboard']),
  firstT: z.number(),
  lastT: z.number(),
  boundFrames: z.number(),
  cls: z.string(),
  stillStored: z.boolean(),
})
const TapeTracksOutputSchema = z.object({
  tapeId: z.string(),
  deviceId: z.number(),
  fromMs: z.number(),
  toMs: z.number(),
  reviewed: z.boolean(),
  lanes: z.array(TapeLaneOutSchema).readonly(),
})
const TapeReviewInputSchema = z.object({ tapeId: z.string().min(1), reviewed: z.boolean() })
/** The node could not answer — never folded into a "nothing to do" (D393). */
const TapeUnavailableSchema = z.object({ status: z.literal('unavailable'), reason: z.string() })
const TapeNotFoundSchema = z.object({ status: z.literal('not-found') })
/**
 * (Fix round, L2.) `update.mutate` is a silent no-op on a missing primary
 * key: the old `{ reviewed: input.reviewed }` shape answered success for a
 * write that did nothing, for an unknown or already-deleted `tapeId`. Now a
 * discriminated union, like `debug.tape.release` / `.delete` — `get` first,
 * refuse `not-found`, never claim a write landed that did not.
 */
const TapeReviewOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reviewed'), reviewed: z.boolean() }),
  TapeNotFoundSchema,
])
const TapeReleaseOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('released'),
    unpinned: z.number(),
    /** False when some unpin did not land; the next tape operation retries. */
    pinsSettled: z.boolean(),
  }),
  z.object({ status: z.literal('already-released') }),
  TapeNotFoundSchema,
  TapeUnavailableSchema,
])
const TapeDeleteOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('deleted') }),
  /** Refused: the row still names pins not yet taken back. */
  z.object({ status: z.literal('pins-owed') }),
  TapeNotFoundSchema,
  TapeUnavailableSchema,
])

export const tapeActions = defineCustomActions({
  'debug.tape.status': customAction(TapeStatusInputSchema, TapeStatusOutputSchema, {
    auth: 'admin',
  }),
  'debug.tape.promote': customAction(PromoteInputSchema, PromoteOutputSchema, { auth: 'admin' }),
  'debug.tape.list': customAction(TapeListInputSchema, TapeListOutputSchema, { auth: 'admin' }),
  'debug.tape.review': customAction(TapeReviewInputSchema, TapeReviewOutputSchema, {
    auth: 'admin',
  }),
  'debug.tape.release': customAction(TapeIdInputSchema, TapeReleaseOutputSchema, {
    auth: 'admin',
  }),
  'debug.tape.delete': customAction(TapeIdInputSchema, TapeDeleteOutputSchema, { auth: 'admin' }),
  'debug.tape.tracks': customAction(TapeIdInputSchema, TapeTracksOutputSchema, { auth: 'admin' }),
})

export type TapeActions = typeof tapeActions
export type DebugTapeStatusInput = z.infer<typeof TapeStatusInputSchema>
export type DebugTapeStatusOutput = z.infer<typeof TapeStatusOutputSchema>
export type DebugTapePromoteInput = z.infer<typeof PromoteInputSchema>
export type DebugTapePromoteOutput = z.infer<typeof PromoteOutputSchema>
export type DebugTapeListInput = z.infer<typeof TapeListInputSchema>
export type DebugTapeListOutput = z.infer<typeof TapeListOutputSchema>
export type DebugTapeListItem = z.infer<typeof TapeListItemSchema>
export type DebugTapeIdInput = z.infer<typeof TapeIdInputSchema>
export type DebugTapeReviewInput = z.infer<typeof TapeReviewInputSchema>
export type DebugTapeReviewOutput = z.infer<typeof TapeReviewOutputSchema>
export type DebugTapeReleaseOutput = z.infer<typeof TapeReleaseOutputSchema>
export type DebugTapeDeleteOutput = z.infer<typeof TapeDeleteOutputSchema>
export type DebugTapeTracksOutput = z.infer<typeof TapeTracksOutputSchema>
