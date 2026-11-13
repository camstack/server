import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * What a preset id DOES on this camera.
 *
 * On several PTZ firmwares the preset namespace is shared: low ids are stored
 * positions, a reserved band triggers camera FUNCTIONS. The dispensa camera
 * (Hikvision) returns its own reserved band in the preset list, named by the
 * firmware:
 *
 *   34 Back to origin · 39 Day mode · 40 Night mode · 46 Day/Night Auto Mode
 *   92 Set manual limits · 93 Save manual limits · 94 Remote reboot
 *   95 Call OSD menu
 *
 * We used to hand all of these to the UI as ordinary presets. Saving over one
 * is what produced `PUT /ISAPI/PTZCtrl/channels/1/presets/34 -> HTTP 500`: the
 * camera refusing to let "Back to origin" be overwritten, surfaced to the
 * operator as a transport failure.
 *
 * A function preset stays fully usable as a DESTINATION -- `goToPreset('34')`
 * is the single most useful thing that camera can do. Only `savePreset` and
 * `deletePreset` are gated.
 */
export const PtzPresetFunctionSchema = z.enum([
  'home',
  'day-mode',
  'night-mode',
  'day-night-auto',
  'set-limits',
  'save-limits',
  'reboot',
  'osd-menu',
])

export type PtzPresetFunction = z.infer<typeof PtzPresetFunctionSchema>

const PtzPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * The firmware function this id performs, when the provider KNOWS the id is
   * reserved. `null` = an ordinary stored position, OR a reserved id this
   * provider does not recognise -- the two are told apart by `writable`.
   */
  fn: PtzPresetFunctionSchema.nullable(),
  /**
   * Whether `savePreset` / `deletePreset` may target this id. A provider sets
   * it false only for a band it KNOWS is reserved; where the firmware is not
   * documented it stays true and a refusal comes from the camera, named.
   */
  writable: z.boolean(),
})
/**
 * Where the head is pointing -- per axis, and `null` when the driver cannot
 * read it.
 *
 * It used to be three REQUIRED numbers, which left a provider that cannot read
 * position no way to say so. All four said `0`:
 *
 *   reolink   `return { pan: 0, tilt: 0, zoom: 0 }`  "until a position-query
 *                                                     path lands upstream"
 *   hikvision stub, "firmware-dependent and frequently absent"
 *   amcrest   stub, "no generic absolute-position read for this model family"
 *   onvif     throws
 *
 * So every consumer asking where a camera points was told "perfectly centred"
 * by four cameras that had never looked. That is D393 -- a measurement that
 * FAILED is `null`, never `0`, and the type says so all the way to the
 * decision -- the same shape as the unreadable `statfs` folded into "0 bytes of
 * headroom", which evacuated a healthy disk.
 *
 * D393 also says to check for a narrower structural TWIN of the result type.
 * There is one: `PtzStatusSchema` extends this, so the lie had already
 * propagated into `getStatus`, which is the surface `getPosition`'s own comment
 * tells callers to migrate to.
 */
const PtzPositionSchema = z.object({
  pan: z.number().nullable(),
  tilt: z.number().nullable(),
  zoom: z.number().nullable(),
})
const PtzMoveCommandSchema = z.object({
  pan: z.number().optional(),
  tilt: z.number().optional(),
  zoom: z.number().optional(),
  speed: z.number().optional(),
})

/** PTZ status — current position plus the camera's autofocus state.
 *  `getPosition` / `move` still operate on the bare position; the
 *  auto-injected `getStatus` returns this richer block. */
const PtzStatusSchema = PtzPositionSchema.extend({ autofocus: z.boolean() })

/** Per-camera PTZ availability descriptor — drives the UI. */
const PtzOptionsSchema = z.object({
  hasPan: z.boolean(),
  hasTilt: z.boolean(),
  hasZoom: z.boolean(),
  supportsPresets: z.boolean(),
  /** Max number of named presets the camera supports, when known. */
  maxPresets: z.number().optional(),
  /** Whether the camera exposes a controllable autofocus toggle
   *  (boolean `hasX` per the getOptions availability convention). */
  hasAutofocus: z.boolean(),
  /**
   * How many distinct speeds this camera's NATIVE scale offers.
   *
   * The cap's `speed` is normalized 0..1 and each provider maps it down --
   * Baichuan 1..63, Dahua 1..8, ISAPI's percentage -100..100. The normalized
   * value hides how coarse that really is: asking an amcrest for `0.37` is
   * meaningless, because it has eight steps and three of them round to the
   * same one. A loop that tunes its own gain has to know the granularity of
   * the knob it is turning.
   *
   * `null` = the driver does not know, or the scale is continuous (ONVIF takes
   * a float). Never a made-up number.
   */
  speedSteps: z.number().int().positive().nullable(),
  /**
   * How long ONE `move` pulse runs on this driver, ms.
   *
   * `move` is a self-terminating burst everywhere, but every provider hardcoded
   * its own duration in private -- 200 reolink, 350 amcrest, 500 hikvision,
   * 1000 onvif -- so no caller could read it. It is the DENOMINATOR of "how far
   * did the head travel per pulse": without it a measured displacement has no
   * gain to be divided into.
   *
   * `null` = the driver cannot say.
   */
  moveImpulseMs: z.number().int().positive().nullable(),
})

/**
 * Which preset `goHome` goes to, and WHO decided.
 *
 * `goHome` used to be three vendor "conventions" written in three comments --
 * Reolink preset 0, Hikvision preset '1', Dahua preset 1 -- and on this fleet
 * not one of the three cameras honours its own:
 *
 *   107  Camera camera Carol (reolink)   preset 0 holds "stanza"
 *   1438 Camera dispensa (hikvision)      preset 1 holds "Credenza"
 *   3836 Camera studio (amcrest)          preset 1 holds "Preset1"
 *
 * So `goHome` meant "go wherever the operator happened to save in slot 0 or 1",
 * and two of the three swallowed the failure in a bare `catch`. For autotrack
 * this is the HOTTEST path -- it runs every time a subject is released -- so it
 * needs an answer that is true per camera and audible when it is missing.
 *
 * `source` is what makes it honest:
 *   - `operator` -- picked in the UI, stored by the provider.
 *   - `firmware` -- the camera itself named a preset `fn: 'home'` (Hikvision's
 *     "Back to origin"), adopted as the default with nothing to configure.
 *   - `native`   -- the driver homes WITHOUT a preset at all. ONVIF does:
 *     `goHome` is `ptzAbsoluteMove({x:0, y:0, zoom:0})`. `presetId` is null and
 *     that is not a failure -- there is nothing to pick, and the UI must offer
 *     no picker.
 *   - `none`     -- nothing is configured and the camera names nothing.
 *     `goHome` REFUSES rather than moving the head somewhere arbitrary.
 *
 * `source === 'none'` is the refusal condition, NOT `presetId === null`: the
 * native case has no preset and homes perfectly well.
 */
export const PtzHomePresetSchema = z.object({
  presetId: z.string().nullable(),
  source: z.enum(['operator', 'firmware', 'native', 'none']),
})

export type PtzHomePreset = z.infer<typeof PtzHomePresetSchema>

/**
 * The camera's own idle-return behaviour: whether it goes home by itself, and
 * after how long.
 *
 * ONE shape, not two scalars, because on the camera they are ONE fact —
 * Reolink's guard point carries `benable` and `timeout` in the same element,
 * written by the same command. Reading them apart means two round-trips that
 * can disagree.
 *
 * `enabled` and `seconds` are INDEPENDENT: a camera can hold a 68 s delay with
 * the behaviour switched off, which is exactly what the vendor app leaves when
 * you turn the guard point off without clearing it. The first version of this
 * cap reported only the delay, so that state was invisible — a camera could be
 * configured to return after 68 seconds with no way to say whether it should
 * return at all.
 */
export const PtzHomeReturnSchema = z.object({
  enabled: z.boolean(),
  seconds: z.number().int(),
})

export type PtzHomeReturn = z.infer<typeof PtzHomeReturnSchema>

export const ptzCapability = {
  name: 'ptz',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/ptz-panel',
      tab: 'ptz',
      topTab: true,
      label: 'PTZ',
      order: 0,
    },
  },
  methods: {
    move: method(PtzMoveCommandSchema.extend({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      notOperatorFacing: 'a relative nudge from the live-view joystick; a fixed place is a preset',
    }),
    continuousMove: method(PtzMoveCommandSchema.extend({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      notOperatorFacing: 'joystick motion held until released — continuous, not a discrete step',
    }),
    /**
     * Move to the camera's configured home preset. THROWS when
     * `getHomePreset()` resolves to `none` -- a head that did not move must
     * never look like a head that went home.
     */
    goHome: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      actions: [
        {
          id: 'ptz.goHome',
          label: t('PTZ go home', 'Torna alla posizione iniziale'),
          phrase: t(
            'Send {device} to its home position',
            'Riporta {device} alla posizione iniziale',
          ),
          icon: 'house',
        },
      ],
    }),
    getPresets: method(z.object({ deviceId: z.number() }), z.array(PtzPresetSchema)),
    goToPreset: method(z.object({ deviceId: z.number(), presetId: z.string() }), z.void(), {
      kind: 'mutation',
      actions: [
        {
          id: 'ptz.goToPreset',
          label: t('PTZ go to preset', 'Vai a un preset'),
          phrase: t('Move {device} to {presetId}', 'Sposta {device} su {presetId}'),
          icon: 'move',
          openArgs: [
            {
              key: 'presetId',
              label: t('Preset', 'Preset'),
              offer: {
                kind: 'dynamic',
                from: 'method',
                method: 'getPresets',
                valueKey: 'id',
                labelKey: 'name',
              },
            },
          ],
        },
      ],
    }),
    savePreset: method(
      z.object({
        deviceId: z.number(),
        presetId: z.string(),
        name: z.string(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'admin',
        actions: [
          {
            id: 'ptz.savePreset',
            label: t('Save PTZ preset here', 'Salva qui un preset'),
            phrase: t(
              'Save where {device} points now as preset {presetId} ({name})',
              'Salva la posizione attuale di {device} come preset {presetId} ({name})',
            ),
            icon: 'bookmark-plus',
            openArgs: [
              {
                key: 'presetId',
                label: t('Preset', 'Preset'),
                offer: {
                  kind: 'dynamic',
                  from: 'method',
                  method: 'getPresets',
                  valueKey: 'id',
                  labelKey: 'name',
                },
              },
              { key: 'name', label: t('Name', 'Nome'), offer: { kind: 'text' } },
            ],
          },
        ],
      },
    ),
    deletePreset: method(z.object({ deviceId: z.number(), presetId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    getOptions: method(z.object({ deviceId: z.number() }), PtzOptionsSchema),
    stop: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      actions: [
        {
          id: 'ptz.stop',
          label: t('Stop moving', 'Ferma il movimento'),
          phrase: t('Stop {device} moving', 'Ferma il movimento di {device}'),
          icon: 'square',
        },
      ],
    }),
    /** Which preset `goHome` targets, and who decided it. */
    getHomePreset: method(z.object({ deviceId: z.number() }), PtzHomePresetSchema),
    /**
     * Pin the home preset for this camera. `null` clears the operator's choice
     * and falls back to whatever the firmware names, or to `none`.
     */
    setHomePreset: method(
      z.object({ deviceId: z.number(), presetId: z.string().nullable() }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'admin',
        actions: [
          {
            id: 'ptz.setHomePreset',
            label: t('Set PTZ home preset', 'Imposta il preset iniziale'),
            phrase: t(
              'Make {presetId} the home position of {device}',
              'Rendi {presetId} la posizione iniziale di {device}',
            ),
            icon: 'house',
            openArgs: [
              {
                key: 'presetId',
                label: t('Preset', 'Preset'),
                offer: {
                  kind: 'dynamic',
                  from: 'method',
                  method: 'getPresets',
                  valueKey: 'id',
                  labelKey: 'name',
                },
              },
            ],
          },
        ],
      },
    ),
    /**
     * Make WHERE THE HEAD IS POINTING RIGHT NOW this camera's home.
     *
     * `setHomePreset` takes a preset id, and a preset id is the wrong shape for
     * the most natural thing an operator does: aim the camera, then say "here".
     * It is also the only shape a camera whose home is NOT a preset can accept
     * -- Reolink's home is a guard point, a stored position with no id at all,
     * and hiding the control for that case (as the UI briefly did) left the one
     * vendor with a native home unable to set it.
     *
     * Each provider does it its own way:
     *   reolink   `setGrd` with `needSetPos`, pinning the guard point here
     *   hikvision / amcrest  save a preset, then pin it as home
     *   onvif     REFUSES -- its home is the PTZ origin and cannot be moved
     *
     * A provider that cannot honour it throws rather than silently doing
     * nothing: an operator who pressed "set home here" and saw no error would
     * believe it took.
     */
    captureHomeHere: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
      actions: [
        {
          id: 'ptz.captureHomeHere',
          label: t('Set PTZ home here', 'Imposta qui la posizione iniziale'),
          phrase: t(
            'Make where {device} points now its home position',
            'Rendi la posizione attuale di {device} la sua posizione iniziale',
          ),
          icon: 'map-pin',
        },
      ],
    }),
    /**
     * Whether the camera returns home on its own when left idle, and after how
     * long. `null` when it has no such behaviour at all.
     *
     * Reolink's guard point carries one (`timeout`, freely settable in
     * seconds). It is a real function of the camera that we did not expose at
     * all, and it belongs next to the home it governs rather than in a vendor
     * settings page nobody associates with Home.
     */
    getHomeReturn: method(z.object({ deviceId: z.number() }), PtzHomeReturnSchema.nullable()),
    /**
     * Set both together. Refused by a camera with no idle-return behaviour.
     *
     * They travel together for the same reason they are read together: the
     * underlying write carries both, so setting one alone means reading the
     * other back first and racing whoever else is writing.
     */
    setHomeReturn: method(
      z.object({
        deviceId: z.number(),
        enabled: z.boolean(),
        seconds: z.number().int().min(0).max(3600),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'admin',
        actions: [
          {
            id: 'ptz.setHomeReturn',
            label: t('Set PTZ return home', 'Imposta il ritorno alla posizione iniziale'),
            phrase: t(
              'Set {device} to return home when idle ({enabled}) after {seconds} s',
              'Imposta {device} per tornare alla posizione iniziale da fermo ({enabled}) dopo {seconds} s',
            ),
            icon: 'undo-2',
            openArgs: [
              {
                key: 'enabled',
                label: t('Return home', 'Torna alla posizione iniziale'),
                offer: { kind: 'boolean' },
              },
              {
                key: 'seconds',
                label: t('Idle seconds', 'Secondi da fermo'),
                offer: { kind: 'number', min: 0, max: 3600, step: 1, unit: 's' },
              },
            ],
          },
        ],
      },
    ),
    /**
     * Pull the current PTZ position. Redundant with the auto-injected
     * `getStatus` method (see `status` below); kept for callers that
     * haven't migrated. Will be folded into `getStatus` in a future
     * cleanup pass once all consumers use the typed status surface.
     */
    getPosition: method(z.object({ deviceId: z.number() }), PtzPositionSchema),
    /** Toggle the camera's autofocus. Only meaningful when
     *  `getOptions().hasAutofocus` is true. */
    setAutofocus: method(z.object({ deviceId: z.number(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      actions: [
        {
          id: 'ptz.autofocusOn',
          label: t('Autofocus on', 'Autofocus attivo'),
          phrase: t('Turn on autofocus on {device}', 'Attiva l’autofocus su {device}'),
          icon: 'focus',
          args: { enabled: true },
        },
        {
          id: 'ptz.autofocusOff',
          label: t('Autofocus off', 'Autofocus spento'),
          phrase: t('Turn off autofocus on {device}', 'Disattiva l’autofocus su {device}'),
          icon: 'focus',
          args: { enabled: false },
        },
      ],
    }),
  },
  status: {
    schema: PtzStatusSchema,
    kind: 'command-driven',
  },
  vocabulary: { noun: t('Pan / tilt / zoom', 'Brandeggio'), order: 3220 },
} as const satisfies CapabilityDefinition

export type IPtzProvider = InferProvider<typeof ptzCapability>
export type PtzPreset = z.infer<typeof PtzPresetSchema>
export type PtzOptions = z.infer<typeof PtzOptionsSchema>
export type PtzStatus = z.infer<typeof PtzStatusSchema>
export {
  PtzPresetSchema,
  PtzPositionSchema,
  PtzStatusSchema,
  PtzMoveCommandSchema,
  PtzOptionsSchema,
}
