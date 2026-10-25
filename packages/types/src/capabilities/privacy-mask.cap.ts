import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import {
  type CapabilityDefinition,
  type InferNativeProvider,
  method,
} from './capability-definition.js'
import {
  MaskPolygonShapeSchema,
  MaskPolygonVerticesSchema,
  MaskRectShapeSchema,
  MaskShapeKindSchema,
} from './mask-shape.js'

/**
 * PRIVACY — what the camera deliberately does not capture. Two planes:
 *
 *  - **video**: up to `maxRegions` SHAPES the camera blanks out (NOT a cell
 *    grid). Reolink `<shelterList>` zones are rectangles; Hikvision ISAPI
 *    `<RegionCoordinatesList>` zones are free polygons (this camera: exactly
 *    4 vertices, not necessarily axis-aligned). The cap composes the shared
 *    rect|polygon subset of the MaskShape vocabulary. All coords are
 *    normalized 0..1 (top-left origin).
 *  - **audio**: the camera's microphone. `setAudioEnabled(false)` stops the
 *    camera encoding an audio track at all, so EVERY consumer — live view,
 *    recording, the audio analyzer, an export — sees silent video. There is
 *    no server-side copy of this fact; the camera is the store and every read
 *    is a read-through, which is why a switch over it cannot drift
 *    ([D62](../../../../docs/decisions/adr-0062.md)).
 *
 * Both belong here for one reason: they are the two things an operator turns
 * off when the answer to "what is this camera allowed to record" changes, and
 * both are applied ON the device, before anything leaves it.
 *
 * **The audio flag has exactly one writer.** `stream-params` used to carry a
 * per-profile `audio` in its patch schema — reachable from no UI and honoured
 * by one provider — and it was removed when this landed. A second writer onto
 * one device register is the shape of every knob this repo has shipped that
 * disagreed with the one the reader read.
 */

/** A privacy-mask region's geometry — rectangle or free polygon. */
export const PrivacyMaskShapeSchema = z.discriminatedUnion('kind', [
  MaskRectShapeSchema,
  MaskPolygonShapeSchema,
])

/** A single privacy-mask zone. */
export const PrivacyMaskRegionSchema = z.object({
  /** Slot id, 0-based. Stable across read/write. */
  id: z.number(),
  /** Whether this zone is active (blanked out by the camera). */
  enabled: z.boolean(),
  shape: PrivacyMaskShapeSchema,
})

/** Current on-camera privacy state — mask master enable + zones + microphone. */
export const PrivacyMaskStatusSchema = z.object({
  enabled: z.boolean(),
  /**
   * Active zones (normalized 0..1). Length ≤ maxRegions.
   *
   * `null` means "no answer" — the provider has never reached this camera
   * (a cold `runtimeState` slice, a battery camera asleep) or the read
   * failed. A consumer must render it as UNKNOWN and never as "this camera
   * has no zones": those two look identical to an operator right up to the
   * moment one of them is acted on, and acting on them differs completely.
   * The switch group turned an unanswered read into *"nothing is set up for
   * it to act on"* — an instruction to go and draw a zone that already
   * exists — and this editor seeded an EMPTY canvas from it, one Save away
   * from deleting the mask it could not read.
   *
   * Empty-and-answered is `[]` and stays a real answer: this camera genuinely
   * has no zones. The distinction is the same one {@link
   * PrivacyMaskStatusSchema.shape.audioEnabled} already draws for the
   * microphone, on the very same payload — both planes come from ONE refresh,
   * so it was never coherent for one of them to be able to say "unknown"
   * while the other could not.
   */
  regions: z.array(PrivacyMaskRegionSchema).nullable(),
  /**
   * Is the camera capturing sound right now? Read from the camera, never from
   * a server-side mirror.
   *
   * `null` means "no answer" — either this camera exposes no controllable
   * microphone (`getOptions().supportsAudioMute === false`) or the read
   * failed. A consumer must render `null` as UNKNOWN and never as `false`:
   * "the microphone is off" and "we could not ask" look identical to an
   * operator only until one of them is wrong.
   *
   * On a camera whose profiles carry the flag independently (Reolink writes
   * it per stream), `true` means AT LEAST ONE profile still carries audio —
   * privacy is only satisfied when every one of them is silent.
   */
  audioEnabled: z.boolean().nullable(),
  lastFetchedAt: z.number(),
})

/** Per-camera availability. Probed, never assumed from the model name. */
export const PrivacyMaskOptionsSchema = z.object({
  /** Maximum number of supported zones. */
  maxRegions: z.number(),
  /** Shape kinds this camera accepts — Reolink: ['rect']; Hikvision: ['rect','polygon']. */
  supportedShapes: z.array(MaskShapeKindSchema),
  /** Polygon vertex bounds when 'polygon' is supported (Hikvision: {min:4,max:4}). */
  polygonVertices: MaskPolygonVerticesSchema.optional(),
  /**
   * Does this camera expose a microphone switch we can actually write?
   *
   * Camera-probed: `true` only when the firmware answered with an audio flag
   * we know how to patch. A camera that never answered is `false` — a control
   * the operator can press that changes nothing is worse than no control, and
   * the switch group renders "not available" instead.
   */
  supportsAudioMute: z.boolean(),
})

/** Partial change — every field optional. */
export const PrivacyMaskPatchSchema = z.object({
  enabled: z.boolean().optional(),
  regions: z.array(PrivacyMaskRegionSchema).optional(),
})

export type PrivacyMaskShape = z.infer<typeof PrivacyMaskShapeSchema>
export type PrivacyMaskRegion = z.infer<typeof PrivacyMaskRegionSchema>
export type PrivacyMaskStatus = z.infer<typeof PrivacyMaskStatusSchema>
export type PrivacyMaskOptions = z.infer<typeof PrivacyMaskOptionsSchema>
export type PrivacyMaskPatch = z.infer<typeof PrivacyMaskPatchSchema>

export const privacyMaskCapability = {
  name: 'privacy-mask',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: { kind: 'widget', widgetId: 'host/privacy-mask-grid', tab: 'image', label: 'Privacy Mask' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), PrivacyMaskOptionsSchema),
    setMask: method(z.object({ deviceId: z.number(), patch: PrivacyMaskPatchSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Turn the camera's microphone on or off, at the camera.
     *
     * Deliberately its OWN mutation rather than a field on
     * {@link PrivacyMaskPatchSchema}: `patch.enabled` already means "the video
     * mask master switch", and overloading it would make one boolean mean two
     * unrelated things on the same call. It is also the only method here whose
     * write leaves the device in a state a later `getStatus` reads back
     * verbatim, which is what makes it safe as a switch authority.
     *
     * A camera whose `getOptions().supportsAudioMute` is false must REJECT
     * this rather than silently accept it — a write nothing applies is exactly
     * what the switch group exists to remove.
     */
    setAudioEnabled: method(z.object({ deviceId: z.number(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  status: { schema: PrivacyMaskStatusSchema, kind: 'poll' },
  runtimeState: PrivacyMaskStatusSchema,

  /**
   * Runtime-state durability: **restored** — operator-drawn regions, zero real churn — 22 writes in 25 minutes, every one of them the clock.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — configuration.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IPrivacyMaskProvider = InferNativeProvider<typeof privacyMaskCapability>

/**
 * Collapse a camera's PER-PROFILE audio flags into the one answer
 * {@link PrivacyMaskStatusSchema.shape.audioEnabled} promises.
 *
 * Both firmwares this cap talks to store the flag per stream profile, and
 * both let those profiles disagree. The rule is `some`, not `every`: privacy
 * is only satisfied when NOTHING is carrying sound, so a camera whose sub
 * stream is still audible must read as `true` and be switchable off — not as
 * `false` because the main stream happens to be muted already.
 *
 * An empty list is `null` ("this camera reported no audio flag at all"),
 * never `false`.
 *
 * Lives here rather than in each provider so the rule the schema documents
 * and the rule the providers apply cannot drift apart.
 */
export function summarisePrivacyAudio(
  profiles: readonly { readonly audioEnabled: boolean }[],
): boolean | null {
  if (profiles.length === 0) return null
  return profiles.some((p) => p.audioEnabled)
}
