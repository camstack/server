import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import {
  type CapabilityDefinition,
  type InferNativeProvider,
  method,
} from './capability-definition.js'
import { MaskRectShapeSchema } from './mask-shape.js'

/**
 * scene-monitor — device-scoped reference-region state cap. An operator marks
 * a rect ROI on a camera frame and names one or more states; the engine
 * (pipeline-analytics, designated post-processing node) reports which state is
 * active on an ongoing basis. Two operator-selectable check modes share every-
 * thing except the comparator: `similarity` (CLIP cosine at the same ROI coords
 * vs condition-tagged references) and `llm` (vision-LLM judgment over the crop).
 *
 * **No `deviceConfig`, deliberately.** This shipped as the D14 widget archetype,
 * which put a "Scenes" tab on one camera's detail page. That is the wrong shape
 * for the thing: a scene is a standing question about the property ("is the bin
 * still out"), and the operator's question is "which of my scenes have tripped",
 * across every camera at once — not "what does camera 102 think". Buried one
 * camera deep it also could not be found. The surface is now a top-level admin
 * page (`/scenes`, `pages/Scenes.tsx`) that lists every scene on every camera and
 * picks the camera inside the create flow, the same shape Events and Faces have.
 *
 * The consequence to keep in mind: `host/scene-monitor-editor` is gone from
 * `HOST_WIDGETS` too. `scripts/check-host-widget-resolves.ts` asserts BOTH
 * directions, so a registration nobody declares fails exactly as loudly as a
 * declaration nobody registers. The editor is imported directly by the page.
 *
 * `status.kind:'push'` — the engine pushes on every hysteresis flip /
 * availability change; consumers never poll.
 */

/** Extensible condition tag. Seeded 'day' | 'ir' (the two variants the operator
 *  captures) plus 'night' | 'dawn' | 'dusk' from the resolver's sun-times band.
 *  Open by design so more can be added without a wire break.
 *
 *  Matching does NOT fall back across conditions: cross-condition cosines are
 *  not comparable, so "I have never seen this scene in this light" is reported
 *  as `unknown`, never guessed. A day reference scored against an IR frame
 *  collapses the cosine and would latch a false alarm every single night. */
export const SceneConditionSchema = z.string()

/** The conditions the resolver can produce. Seeds for the UI's coverage line;
 *  the wire type stays an open string. */
export const SCENE_CONDITIONS = ['day', 'ir', 'night', 'dawn', 'dusk'] as const

/**
 * What a scene does when the CURRENT light has no reference of its own.
 *
 * The lighting variants are not equally likely to exist. Almost every operator
 * captures daylight and then never stands outside at 22:00 to capture IR, and a
 * scene that is only ever going to be asked about a daytime question ("is the
 * bin still on the kerb at 08:00") does not need a night reference at all. The
 * night half must therefore be OPTIONAL, and optional means the scene keeps
 * working without it rather than degrading into a permanent complaint.
 *
 * - `skip` (default) — the check in that light is not made. Not a verdict, not
 *   an alarm, not even an `unknown`: the live state simply stays whatever the
 *   last covered light left it at, the latch is untouched, and the hysteresis
 *   run is neither spent nor cleared. The scene resumes by itself at first
 *   light. This is the only behaviour under which "I never captured IR" is a
 *   configuration choice instead of a nightly fault.
 * - `judge-anyway` — score against the OTHER conditions' references. Available
 *   for cameras whose IR frame is close enough to daylight (a floodlit
 *   driveway, an always-white-light doorbell), and wrong for everything else:
 *   cross-condition cosines are not comparable, so a day reference against a
 *   true IR frame collapses and the scene reports a theft at 21:40.
 *
 * Never applies when the scene has NO comparable reference at all — that is
 * "not armed yet", it is reported as `no-reference-for-condition`, and silence
 * there would hide a scene the operator never finished setting up.
 */
export const SceneUncoveredPolicySchema = z.enum(['skip', 'judge-anyway'])

/** Reserved, engine-owned state id standing for "the region no longer looks
 *  like ANY captured reference". Never authored by an operator, never stored in
 *  `states[]` — it is the synthetic candidate that makes divergence a
 *  first-class hysteresis input rather than a bare `return`. */
export const SCENE_DIVERGED = '__diverged__'

/** `matched` = the baseline is what we see; `diverged` = it demonstrably is not;
 *  `unknown` = we cannot judge (no reference for this condition, encoder model
 *  changed, view shifted, no snapshot). `unknown` is a real value, not a null,
 *  and never counts toward hysteresis in either direction. */
export const SceneVerdictSchema = z.enum(['matched', 'diverged', 'unknown'])

/** Why a scene cannot judge. Named, because this feature's failure mode is
 *  silence that reads as "nothing has happened". */
export const SceneUnavailableSchema = z.enum([
  'no-reference-for-condition',
  'view-shifted',
  'no-vision-profile',
  'encoder-model-changed',
  'no-snapshot',
])

/** One captured reference — condition-tagged, model-version-gated. `embedding`
 *  is `number[]` (Float32Array does NOT survive MsgPack/UDS). */
export const SceneReferenceSchema = z.object({
  embedding: z.array(z.number()),
  modelId: z.string(),
  condition: SceneConditionSchema,
  capturedAt: z.number(),
  /**
   * The reference thumbnail's media ROW id (D482).
   *
   * The name already said `mediaId` while the value was the row's composite
   * key — a leftover that read as done and was not. It is the row's own id
   * now, addressed at `/addon/<addonId>/event-media/m/<id>`.
   */
  thumbnailMediaId: z.number().int().optional(),
  /** Whole-frame (downscaled) embedding captured alongside the ROI crop. The
   *  anti-view-shift anchor: a bumped camera, a PTZ preset or a re-aim makes the
   *  normalized rect frame a different piece of world, and the scene would
   *  diverge forever with a perfectly plausible cosine. Checked LAZILY, only
   *  when hysteresis is about to flip — one extra encode per candidate
   *  transition, not per poll. */
  anchorEmbedding: z.array(z.number()).optional(),
})

export const SceneMonitorStateSchema = z.object({
  id: z.string(),
  label: z.string(),
  references: z.array(SceneReferenceSchema),
  textPrompts: z.array(z.string()).optional(), // zero-shot fallback, similarity only
  referenceCount: z.number(),
  currentlyMatched: z.boolean(),
})

/** Per-mode comparator params in a discriminated union so an `llm` scene never
 *  carries similarity knobs and vice-versa. */
export const SceneCheckSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('similarity'),
    threshold: z.number().min(0).max(1),
    hysteresisCount: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal('llm'),
    prompt: z.string(),
    profileId: z.string().optional(),
    hysteresisCount: z.number().int().positive(),
  }),
])

/** Defaults, as CONSTANTS rather than only as Zod `.default()`. A Zod default
 *  does NOT run on the addon→addon cap path, so every runtime seam reads these
 *  as absent-with-a-constant (the `NcConfirmSchema` lesson, three production
 *  failures in one day). The schema defaults and these values are the same
 *  numbers on purpose. */
export const SCENE_DEFAULT_QUIET_SECONDS = 60
export const SCENE_DEFAULT_OBSERVATION_SPACING_SEC = 120
export const SCENE_DEFAULT_CHECK_INTERVAL_SEC = 60
export const SCENE_DEFAULT_ANCHOR_THRESHOLD = 0.85
/** Night is OPTIONAL. A scene with only a daylight reference sits the IR hours
 *  out in silence rather than reporting a fault every night. */
export const SCENE_DEFAULT_UNCOVERED_POLICY = 'skip'
export const SCENE_CONFIRM_DEFAULT_TIMEOUT_MS = 8_000
export const SCENE_CONFIRM_DEFAULT_MAX_IMAGE_PX = 448
/** `resetScene({ recapture })` absent means TRUE — the operator decision. Read
 *  at the seam, because a Zod `.optional()` carries no default at all. */
export const SCENE_RESET_RECAPTURES = true

/**
 * Vision-model adjudication of a candidate flip. Field names deliberately
 * mirror `NcConfirmSchema` so an operator meets one vocabulary, not two.
 *
 * `onTimeout` defaults to **'hold'**, the OPPOSITE of `NcConfirmGate`'s
 * fail-open: a notification suppressed is the worse error there, but a vision
 * model that timed out has not told us the bin is gone, and a latch is a
 * stateful claim that costs the operator a trip to reset.
 */
export const SceneConfirmSchema = z.object({
  enabled: z.boolean().default(false),
  prompt: z.string().min(1).max(1_000),
  profileId: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(20_000).default(SCENE_CONFIRM_DEFAULT_TIMEOUT_MS),
  maxImagePx: z.number().int().min(64).max(2_048).default(SCENE_CONFIRM_DEFAULT_MAX_IMAGE_PX),
  /** What a timeout / unavailable model means for the PENDING flip. */
  onTimeout: z.enum(['flip', 'hold']).default('hold'),
})

export const SceneMonitorSchema = z.object({
  id: z.string(),
  label: z.string(),
  roi: MaskRectShapeSchema, // shared rect member — not a bespoke {x,y,w,h}
  enabled: z.boolean(),
  triggerMode: z.enum(['periodic', 'on-motion', 'both']),
  checkIntervalSec: z.number().optional(), // overrides the mode default when set
  check: SceneCheckSchema,
  states: z.array(SceneMonitorStateSchema),
  currentStateId: z.string().nullable(),
  lastCheckedAt: z.number().nullable(),
  lastConfidence: z.number().nullable(),
  currentCondition: SceneConditionSchema.nullable(), // condition of the last check
  availability: z.enum(['ok', 'unavailable']),
  unavailableReason: z.string().nullable(),

  // --- the operator's boolean, as a PROJECTION of states[] + currentStateId ---
  // No `mode: 'boolean' | 'states'` field: it would be a second source of truth
  // over a distinction the data already makes (`states.length === 1`). D62.

  /** Which state is "the initial screen". `null` until the first capture. */
  baselineStateId: z.string().nullable(),
  /** Which boolean drives notification rules and any export. */
  emit: z.enum(['latched', 'live']).default('latched'),
  /** Live: does the region match the baseline RIGHT NOW. */
  verdict: SceneVerdictSchema,
  /** Has it been `diverged` at least once since `armedAt` — the operator's boolean. */
  latched: z.boolean(),
  /** Last reset (or creation). */
  armedAt: z.number(),
  divergedAt: z.number().nullable(),
  restoredAt: z.number().nullable(),
  /** A check is only COUNTED when the device has been quiet this long. Motion
   *  during the window DISCARDS the observation — a car pulling up in front of
   *  the bin must not be able to spend hysteresis credit. */
  quietSeconds: z.number().int().min(0).max(3_600).default(SCENE_DEFAULT_QUIET_SECONDS),
  /** An observation only advances the pending count when it is at least this
   *  far from the previously counted one, so N agreeing checks span real time
   *  rather than N adjacent polls inside one occlusion. */
  minObservationSpacingSec: z
    .number()
    .int()
    .min(0)
    .max(3_600)
    .default(SCENE_DEFAULT_OBSERVATION_SPACING_SEC),
  /** Vision-model adjudication of a candidate flip. Similarity primary only. */
  confirm: SceneConfirmSchema.optional(),
  /** Whole-frame anchor cosine below which a flip is REFUSED as `view-shifted`. */
  anchorThreshold: z.number().min(0).max(1).default(SCENE_DEFAULT_ANCHOR_THRESHOLD),
  /** Clear the latch on its own when the scene matches again? Default false —
   *  `restoredAt` and the `scene-restored` edge are recorded regardless, so an
   *  automation can react to the bin coming back without the operator's own
   *  alarm silently clearing itself. */
  autoRestore: z.boolean().default(false),
  /** What to do when the current light has no reference of its own. See
   *  {@link SceneUncoveredPolicySchema} — the default makes night OPTIONAL. */
  onUncoveredCondition: SceneUncoveredPolicySchema.default(SCENE_DEFAULT_UNCOVERED_POLICY),
  /**
   * The light whose checks are currently being SAT OUT under
   * `onUncoveredCondition: 'skip'` — `null` when the scene is checking normally.
   *
   * Engine-reported and advisory only: it moves no verdict, no latch and no
   * hysteresis. It exists so the card can say *"night (IR) — checks paused,
   * nothing captured in this light"* in the same calm voice as the coverage
   * line, because the alternative is a scene that silently stops answering
   * after sunset with nothing anywhere saying why. A skipped check must never
   * read as a broken one.
   */
  suspendedCondition: SceneConditionSchema.nullable().default(null),
  /** Named cause when `verdict === 'unknown'`. */
  unavailable: SceneUnavailableSchema.nullable(),
  /** Conditions that have at least one comparable reference — the coverage line
   *  ("day ✓ · ir ✓ · dusk ✗") that turns a silent fallback into a visible fact. */
  coveredConditions: z.array(SceneConditionSchema),
})

export const SceneMonitorStatusSchema = z.object({
  monitors: z.array(SceneMonitorSchema),
  lastFetchedAt: z.number(), // required by the runtimeState bridge convention
})

export type SceneCondition = z.infer<typeof SceneConditionSchema>
export type SceneVerdict = z.infer<typeof SceneVerdictSchema>
export type SceneUnavailable = z.infer<typeof SceneUnavailableSchema>
export type SceneUncoveredPolicy = z.infer<typeof SceneUncoveredPolicySchema>
export type SceneConfirm = z.infer<typeof SceneConfirmSchema>
export type SceneReference = z.infer<typeof SceneReferenceSchema>
export type SceneMonitorState = z.infer<typeof SceneMonitorStateSchema>
export type SceneCheck = z.infer<typeof SceneCheckSchema>
export type SceneMonitor = z.infer<typeof SceneMonitorSchema>
export type SceneMonitorStatus = z.infer<typeof SceneMonitorStatusSchema>

/**
 * One camera's row in a `listScenesBatch` answer.
 *
 * `status` is NULLABLE and the nullability is the whole point. `scene-monitor`
 * is a `defaultActive` wrapper, so every camera is asked; a camera whose
 * provider is absent (pipeline-analytics not deployed, the post-processing node
 * down) cannot answer, and that is not the same fact as a camera with no scenes
 * configured. Fanned out per camera the difference was visible — one query
 * errored while the others resolved — and a batch that returned only the rows
 * it managed would have destroyed it, silently, by making an unreachable camera
 * indistinguishable from one that answered `monitors: []`.
 *
 * So: EVERY requested deviceId gets a row. `status: null` means "this camera
 * could not be read"; `status.monitors: []` means "read, and it has none".
 */
export const SceneMonitorStatusForDeviceSchema = z.object({
  deviceId: z.number(),
  status: SceneMonitorStatusSchema.nullable(),
})
export type SceneMonitorStatusForDevice = z.infer<typeof SceneMonitorStatusForDeviceSchema>

export const sceneMonitorCapability = {
  name: 'scene-monitor',
  // Every method is the 'scenes' feature a viewer may be granted (D921).
  role: { feature: 'scenes' },
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  methods: {
    listScenes: method(z.object({ deviceId: z.number() }), SceneMonitorStatusSchema),
    /**
     * The same answer, for a SET of cameras, in one round trip.
     *
     * `/scenes` renders every camera and re-reads them on a 30s safety-net
     * poll behind the push slice. Fanned out client-side that was one query
     * per camera — 29 round trips through the browser, the hub and the
     * post-analysis runner every 30 seconds to read an in-memory map the
     * owner had already merged. The work is unchanged (`statusFor` per
     * device, all in-process at the owner); what collapses is the transport.
     *
     * A camera that cannot answer still gets a row, with `status: null` —
     * see {@link SceneMonitorStatusForDeviceSchema}. Never fewer rows than
     * ids: a caller that asked for twenty-nine and got twenty-seven cannot
     * tell which two are missing, or that any are.
     */
    listScenesBatch: method(
      z.object({ deviceIds: z.array(z.number()).min(1).max(200) }),
      z.array(SceneMonitorStatusForDeviceSchema).readonly(),
    ),
    createScene: method(
      z.object({
        deviceId: z.number(),
        label: z.string(),
        roi: MaskRectShapeSchema,
        check: SceneCheckSchema,
        triggerMode: z.enum(['periodic', 'on-motion', 'both']).optional(),
        checkIntervalSec: z.number().optional(),
      }),
      SceneMonitorSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    updateScene: method(
      z.object({
        deviceId: z.number(),
        monitorId: z.string(),
        patch: z.object({
          label: z.string().optional(),
          roi: MaskRectShapeSchema.optional(),
          enabled: z.boolean().optional(),
          triggerMode: z.enum(['periodic', 'on-motion', 'both']).optional(),
          checkIntervalSec: z.number().optional(),
          check: SceneCheckSchema.optional(),
          emit: z.enum(['latched', 'live']).optional(),
          quietSeconds: z.number().int().min(0).max(3_600).optional(),
          minObservationSpacingSec: z.number().int().min(0).max(3_600).optional(),
          anchorThreshold: z.number().min(0).max(1).optional(),
          autoRestore: z.boolean().optional(),
          onUncoveredCondition: SceneUncoveredPolicySchema.optional(),
          /** `null` clears the vision-model adjudicator. */
          confirm: SceneConfirmSchema.nullable().optional(),
        }),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteScene: method(z.object({ deviceId: z.number(), monitorId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    captureReference: method(
      z.object({
        deviceId: z.number(),
        monitorId: z.string(),
        stateId: z.string().optional(), // creates a new state when omitted
        label: z.string().optional(),
        condition: SceneConditionSchema.optional(), // defaults to detected condition
      }),
      z.object({ stateId: z.string(), referenceCount: z.number() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteReference: method(
      z.object({
        deviceId: z.number(),
        monitorId: z.string(),
        stateId: z.string(),
        index: z.number(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    recheckNow: method(z.object({ deviceId: z.number(), monitorId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Clear the latch, re-arm, and — by default — RE-CAPTURE the baseline for
     * the CURRENT condition. The bin never goes back in exactly the same spot;
     * "reset" in the operator's head means *this is the new normal*, and
     * re-capture is what makes the feature self-healing against slow drift
     * instead of failing silently weeks later.
     *
     * Reachable from three surfaces on this one mutation: the scene card, a
     * notification button (an `onTrigger` sequence with a `kind:'cap'` step —
     * no new Notification-Center code at all), and tRPC for scripts.
     */
    resetScene: method(
      z.object({
        deviceId: z.number(),
        monitorId: z.string(),
        /** Defaults to TRUE at the provider seam — see `SCENE_RESET_RECAPTURES`. */
        recapture: z.boolean().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  status: { schema: SceneMonitorStatusSchema, kind: 'push' },
  runtimeState: SceneMonitorStatusSchema,

  /**
   * Runtime-state durability: **session** — re-derived from the current scene on the next evaluation.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — nested configuration.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type ISceneMonitorProvider = InferNativeProvider<typeof sceneMonitorCapability>
