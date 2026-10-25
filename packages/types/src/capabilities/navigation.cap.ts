import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * `navigation` — a device-scoped capability that natively expresses the FULL
 * navigation / action surface of a robot that DRIVES ITSELF and carries an
 * on-board camera (the Dreame robot-vacuum camera is the first provider).
 *
 * Why a NEW cap rather than overloading `ptz`:
 *   - `ptz` moves a *gimbal* on a fixed camera (pan/tilt/zoom of the lens). A
 *     robot vacuum has no gimbal — the whole chassis drives, turns and spins.
 *     The two are different physical models: PTZ is absolute-position + presets,
 *     navigation is momentary drive nudges + discrete robot ACTIONS
 *     (dock / spot-clean / follow-pet / go-to-point / …).
 *   - This cap is the SOURCE OF TRUTH. Two consumers adapt from it rather than
 *     the reverse:
 *       1. a native CamStack navigation panel (data-driven from `listActions`
 *          / `getOptions`), and
 *       2. the PTZ surface — a thin adapter mimics `ptz` from `navigation` so a
 *          robot camera shows up in the existing PTZ control path without every
 *          PTZ provider learning about robots. The mapping lives in the adapter,
 *          not here (see the addon design note):
 *            ptz.continuousMove({pan,tilt}) → navigation.move({pan,tilt})
 *            ptz.stop()                      → navigation.stop()
 *            ptz.goHome()                    → navigation.runAction('goHome')
 *            ptz.getPresets()                → navigation.listActions()  (id→preset)
 *            ptz.goToPreset(id)              → navigation.runAction(id)
 *
 * ## Continuous drive
 *
 * `move` is MOMENTARY. Fluid navigation comes from the UI (or the PTZ adapter)
 * sending `move({pan,tilt})` REPEATEDLY at ~1 Hz while a direction is held, and
 * one `stop()` on release — exactly like the robot app's remote-drive joystick.
 * The provider forwards EACH `move` to one drive write; it must NOT debounce or
 * coalesce them. The UI owns the cadence.
 *
 * ## The action dictionary
 *
 * The discrete controls (dock / locate / spot-clean / follow / flash / sounds)
 * are a DATA-DRIVEN dictionary the cap exposes via `listActions()`. Each entry
 * carries `{ id, kind, label, icon }` (plus `soundId` for sound entries) so the
 * native panel AND the PTZ mimic render buttons WITHOUT hardcoding a
 * vendor-specific list. `kind: 'action'` entries are triggered with
 * `runAction({ actionId })`; `kind: 'sound'` entries with `playSound({ soundId })`
 * (the entry carries the `soundId` to pass). The general primitives — `move`,
 * `stop`, `goToPoint` — stay as first-class methods, not dictionary entries.
 *
 * NOTE (provider wiring): the first provider (Dreame) drives this with the RAW
 * `callAction(siid,aiid,in)` / `setProperty({siid,piid,value})` MIoT primitives
 * that the currently-published `@apocaliss92/nodedreame` already exposes on
 * every device handle. A future nodedreame publish adds a typed
 * `DreameCameraController` (drive / playPetSound / spotClean / findPet / …); the
 * provider can then swap the raw calls for the typed methods with no change to
 * THIS contract.
 */

// ── Continuous drive ────────────────────────────────────────────────

/**
 * A momentary drive nudge. The robot MOVES (no gimbal) for as long as the caller
 * keeps sending nudges (~1 Hz); an explicit `stop` (or letting the nudges lapse)
 * halts it.
 *
 *   - `pan`   — turn: negative = left, positive = right, 0 = straight.
 *   - `tilt`  — throttle: positive = forward, negative = spin / turn-around.
 *   - `speed` — optional intensity hint [0, 1]; the provider may scale the drive
 *               vector by it (drivers without proportional drive ignore it).
 *
 * `pan` / `tilt` are normalized [-1, 1]. Both optional so a caller can nudge one
 * axis alone; an all-undefined nudge is a no-op.
 */
export const NavigationMoveCommandSchema = z.object({
  pan: z.number().min(-1).max(1).optional(),
  tilt: z.number().min(-1).max(1).optional(),
  speed: z.number().min(0).max(1).optional(),
})
export type NavigationMoveCommand = z.infer<typeof NavigationMoveCommandSchema>

// ── Discrete actions ────────────────────────────────────────────────

/**
 * The enumerated discrete actions a navigation-capable robot can perform via
 * `runAction`. This is the CLOSED vocabulary; a given device advertises the
 * subset it supports through `listActions`. Sounds are NOT here — they go through
 * `playSound` (see the `sound` dictionary entries).
 */
export const NavigationActionIdSchema = z.enum([
  'goHome',
  'locate',
  'spotClean',
  'findPet',
  'personFollow',
  'stop',
  'startClean',
  'pauseClean',
  'dockWash',
  'autoEmpty',
  'flashOn',
  'flashOff',
])
export type NavigationActionId = z.infer<typeof NavigationActionIdSchema>

/** Whether a dictionary entry is a `runAction` action or a `playSound` sound. */
export const NavigationEntryKindSchema = z.enum(['action', 'sound'])
export type NavigationEntryKind = z.infer<typeof NavigationEntryKindSchema>

/**
 * One entry in the navigation action dictionary — the DATA-DRIVEN unit both the
 * native panel and the PTZ mimic render as a button.
 *
 *   - `id`      — stable id. For `kind:'action'` it is a {@link NavigationActionId}
 *                 (pass to `runAction`); for `kind:'sound'` it is a namespaced id
 *                 (`sound:meow`) whose `soundId` is passed to `playSound`.
 *   - `icon`    — icon HINT (lucide-style name; the UI maps it to its own set).
 *   - `label`   — operator-facing English label.
 *   - `soundId` — wire sound id, present only on `kind:'sound'` entries.
 *   - `enabled` — per-device FEATURE FLAG. `listActions` reports it so the UI /
 *                 PTZ render ONLY enabled entries. Data-driven: the provider
 *                 flips it from config, never by editing code.
 */
export const NavigationActionEntrySchema = z.object({
  id: z.string(),
  kind: NavigationEntryKindSchema,
  label: z.string(),
  icon: z.string(),
  /** Present only on `kind:'sound'` entries — the id to pass to `playSound`. */
  soundId: z.number().int().optional(),
  /** Per-device feature flag — render this entry only when true. */
  enabled: z.boolean(),
})
export type NavigationActionEntry = z.infer<typeof NavigationActionEntrySchema>

/**
 * Canonical dictionary of every navigation control (discrete actions + sounds)
 * with its default label + icon hint. A provider filters this to the subset a
 * device supports (and may override a label). Exported so the provider AND the
 * UI share ONE list instead of re-deriving labels / ids independently.
 *
 * Icons are lucide-style hints; the viewer maps them to its own icon set. Every
 * catalog default is `enabled: true`; a provider overrides per-device from
 * config (data-driven — enabling / disabling one later is a config change, not a
 * code change).
 */
export const NAVIGATION_ACTION_CATALOG: readonly NavigationActionEntry[] = [
  { id: 'startClean', kind: 'action', label: 'Start cleaning', icon: 'play', enabled: true },
  { id: 'pauseClean', kind: 'action', label: 'Pause cleaning', icon: 'pause', enabled: true },
  { id: 'stop', kind: 'action', label: 'Stop', icon: 'hand', enabled: true },
  { id: 'goHome', kind: 'action', label: 'Return to dock', icon: 'home', enabled: true },
  { id: 'locate', kind: 'action', label: 'Locate', icon: 'bell', enabled: true },
  { id: 'spotClean', kind: 'action', label: 'Spot clean here', icon: 'crosshair', enabled: true },
  { id: 'findPet', kind: 'action', label: 'Find pet', icon: 'paw-print', enabled: true },
  { id: 'personFollow', kind: 'action', label: 'Follow me', icon: 'footprints', enabled: true },
  { id: 'dockWash', kind: 'action', label: 'Wash mop', icon: 'droplets', enabled: true },
  { id: 'autoEmpty', kind: 'action', label: 'Empty dustbin', icon: 'trash-2', enabled: true },
  { id: 'flashOn', kind: 'action', label: 'Flash on', icon: 'flashlight', enabled: true },
  { id: 'flashOff', kind: 'action', label: 'Flash off', icon: 'flashlight-off', enabled: true },
  { id: 'sound:meow', kind: 'sound', label: 'Meow', icon: 'cat', soundId: 684, enabled: true },
  { id: 'sound:bark', kind: 'sound', label: 'Woof', icon: 'dog', soundId: 685, enabled: true },
  {
    id: 'sound:footsteps',
    kind: 'sound',
    label: 'Footsteps',
    icon: 'footprints',
    soundId: 686,
    enabled: true,
  },
  {
    id: 'sound:purring',
    kind: 'sound',
    label: 'Purring',
    icon: 'cat',
    soundId: 687,
    enabled: true,
  },
  {
    id: 'sound:tickTock',
    kind: 'sound',
    label: 'Tick-tock',
    icon: 'clock',
    soundId: 688,
    enabled: true,
  },
] as const

/** Coordinates for `goToPoint` — a point on the robot's live map. */
export const NavigationPointSchema = z.object({ x: z.number(), y: z.number() })
export type NavigationPoint = z.infer<typeof NavigationPointSchema>

// ── Per-device feature flags (getFeatures) ──────────────────────────

/**
 * Per-device FEATURE-FLAG report for the general (non-dictionary) primitives.
 * The cap reports which are enabled so the UI / PTZ render only the controls
 * that are turned on for THIS device. Data-driven: the provider derives these
 * from config + probe, never hardcoded in the UI. The per-DICTIONARY-entry flags
 * live on {@link NavigationActionEntrySchema.enabled}; these gate the primitives
 * that are not dictionary entries.
 *
 *   - `move` / `stop`   — the momentary drive joystick.
 *   - `goToPoint`       — send-to-map-coordinate. Ships OFF on Dreame until the
 *                         map-coordinate plumbing is wired.
 *   - `runAction`       — the discrete action buttons (dictionary `kind:'action'`).
 *   - `playSound`       — the sound buttons (dictionary `kind:'sound'`).
 *   - `light`           — the on/off fill-light toggle (works anytime).
 *   - `lightMode`       — the auto/manual selector + manual level slider (a
 *                         camera-service control; needs an active stream).
 */
export const NavigationFeaturesSchema = z.object({
  move: z.boolean(),
  stop: z.boolean(),
  goToPoint: z.boolean(),
  runAction: z.boolean(),
  playSound: z.boolean(),
  light: z.boolean(),
  lightMode: z.boolean(),
})
export type NavigationFeatures = z.infer<typeof NavigationFeaturesSchema>

/** Light mode: `auto` lets the camera choose brightness; `manual` uses `level`. */
export const NavigationLightModeSchema = z.enum(['auto', 'manual'])
export type NavigationLightMode = z.infer<typeof NavigationLightModeSchema>

/** Manual fill-light level bounds (the camera-service accepts 40..100). */
export const NAVIGATION_LIGHT_LEVEL_MIN = 40
export const NAVIGATION_LIGHT_LEVEL_MAX = 100

// ── Status / runtime-state ──────────────────────────────────────────

/** Coarse work mode the robot reports — drives the UI's active-state chips. */
export const NavigationModeSchema = z.enum([
  'idle',
  'cleaning',
  'spot',
  'following',
  'goto',
  'returning',
  'paused',
  'unknown',
])
export type NavigationMode = z.infer<typeof NavigationModeSchema>

/**
 * Live navigation state so the UI can reflect what the robot is doing:
 *   - `mode`       — coarse activity (idle / cleaning / following / …).
 *   - `following`  — person/pet follow is currently armed.
 *   - `flash`      — the on-camera fill light is on.
 *   - `lightMode`  — auto vs manual fill-light mode.
 *   - `lightLevel` — manual fill-light level (40..100); meaningful when
 *                    `lightMode === 'manual'`.
 */
export const NavigationStatusSchema = z.object({
  mode: NavigationModeSchema,
  following: z.boolean(),
  flash: z.boolean(),
  lightMode: NavigationLightModeSchema,
  lightLevel: z.number().min(NAVIGATION_LIGHT_LEVEL_MIN).max(NAVIGATION_LIGHT_LEVEL_MAX),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})
export type NavigationStatus = z.infer<typeof NavigationStatusSchema>

/**
 * Runtime-state slice owned by this cap (kernel-managed: validated, mirrored,
 * observable). Adds `lastFetchedAt` on top of the status shape per the
 * convention.
 */
export const NavigationRuntimeStateSchema = NavigationStatusSchema.extend({
  lastFetchedAt: z.number(),
})
export type NavigationRuntimeState = z.infer<typeof NavigationRuntimeStateSchema>

export const navigationCapability = {
  name: 'navigation',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Camera surface: the robot's camera+navigation device is a `Camera`, so the
  // navigation panel and the PTZ-mimic adapter both live on the camera device.
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/navigation-panel',
      tab: 'navigation',
      topTab: true,
      label: 'Navigation',
      order: 0,
    },
  },
  methods: {
    /**
     * Momentary drive nudge (the robot moves). `protected` — mirrors
     * `ptz.continuousMove` so the Viewer navigation panel (and the PTZ-mimic
     * path) works for any authenticated user, not admin-only. The UI sends
     * these at ~1 Hz while a control is held; the provider forwards each one to
     * a single drive write WITHOUT debouncing.
     */
    move: method(NavigationMoveCommandSchema.extend({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
    }),
    /** Halt all motion immediately (zero drive vector). */
    stop: method(z.object({ deviceId: z.number() }), z.void(), { kind: 'mutation' }),
    /** Send the robot to a point on its live map. */
    goToPoint: method(NavigationPointSchema.extend({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
    }),
    /**
     * Enumerate the discrete controls THIS device supports (data-driven UI +
     * PTZ mimic). Camera-probed subset of {@link NAVIGATION_ACTION_CATALOG}.
     */
    listActions: method(z.object({ deviceId: z.number() }), z.array(NavigationActionEntrySchema)),
    /**
     * Run one discrete action (a `kind:'action'` dictionary entry). Invalid /
     * unsupported action ids are rejected by the provider.
     */
    runAction: method(
      z.object({ deviceId: z.number(), actionId: NavigationActionIdSchema }),
      z.void(),
      { kind: 'mutation' },
    ),
    /** Play a sound by its wire id (the `soundId` of a `kind:'sound'` entry). */
    playSound: method(z.object({ deviceId: z.number(), soundId: z.number().int() }), z.void(), {
      kind: 'mutation',
    }),
    /**
     * Turn the on-camera fill light on / off (the `OpenFullLight` control —
     * works anytime, no active stream required).
     */
    setLightOn: method(z.object({ deviceId: z.number(), on: z.boolean() }), z.void(), {
      kind: 'mutation',
    }),
    /**
     * Set the fill-light mode (auto vs manual). `manual` optionally carries the
     * initial `level`. The auto/manual + level control is a CAMERA-service
     * action that generally needs an active camera stream/monitor session — the
     * UI shows the manual level slider ONLY when `mode === 'manual'`.
     */
    setLightMode: method(
      z.object({
        deviceId: z.number(),
        mode: NavigationLightModeSchema,
        level: z
          .number()
          .min(NAVIGATION_LIGHT_LEVEL_MIN)
          .max(NAVIGATION_LIGHT_LEVEL_MAX)
          .optional(),
      }),
      z.void(),
      { kind: 'mutation' },
    ),
    /** Set the MANUAL fill-light level (40..100). Implies `manual` mode. */
    setLightLevel: method(
      z.object({
        deviceId: z.number(),
        level: z.number().min(NAVIGATION_LIGHT_LEVEL_MIN).max(NAVIGATION_LIGHT_LEVEL_MAX),
      }),
      z.void(),
      { kind: 'mutation' },
    ),
    /**
     * Per-device FEATURE-FLAG report for the general primitives — drives which
     * controls the UI shows (the per-entry flags for the dictionary come back on
     * `listActions`).
     */
    getFeatures: method(z.object({ deviceId: z.number() }), NavigationFeaturesSchema),
  },
  events: {
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: NavigationStatusSchema,
      }),
    },
  },
  status: {
    schema: NavigationStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice mirrored by the kernel. The navigation panel watches it
   * for live mode / follow / flash changes.
   */
  runtimeState: NavigationRuntimeStateSchema,

  /**
   * Runtime-state durability: **session** — like `vacuum-control`, a restored
   * `mode: cleaning` / `following: true` is a robot that is not actually doing
   * that. The live handle re-publishes on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — control state of a robotic camera, configuration-like.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type INavigationProvider = InferProvider<typeof navigationCapability>
