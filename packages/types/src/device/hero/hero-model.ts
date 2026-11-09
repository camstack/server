/**
 * The hero MODEL (D1023): what a device's hero says, as pure data. One base
 * shape for every device, filled by the capabilities the device is bound to;
 * a type chooses its look and which ROWS it carries, never the base slots.
 *
 * The base slots are reserved — filled when the device has the cap, empty
 * space otherwise:
 *   - `remote`        the button (the remote itself is a separate sheet);
 *   - `consumables`   an icon that opens a tooltip;
 *   - `consumption`   ONE value (power in W, else the running state) whose
 *                     tooltip carries the detail;
 *   - `ownPower`      the device's OWN power (`switch`, or the media player's
 *                     turn on / off), with `timedRun` beside it when offered;
 *   - `powerSupply`   the plug that feeds the device (`power-source`).
 * `ownPower` and `powerSupply` are never merged and no layout can hide
 * either (Addendum 6): they are not part of {@link HeroLayout}.
 *
 * Zod-first, so the `hero-layout` cap serves it without a second declaration of
 * the shape; both clients render this and nothing else. No React, no I/O.
 */
import { z } from 'zod'
import { TimedRunQuickRunSchema } from '../../capabilities/timed-run.cap.js'
import { IconKeySchema, type IconKey } from '../icon-catalog.js'
import {
  HERO_ANIMATIONS,
  HERO_BACKGROUNDS,
  HeroStateSchema,
  HeroToneSchema,
  StateLookSchema,
  type HeroTone,
} from './hero-state.js'
import { HeroSceneSchema } from './hero-scene.js'
import { HeroTextSchema, heroText, type HeroText } from './hero-text.js'

/** The rows a layout may carry. Each is built from the caps the device is bound to. */
export const HERO_ROW_IDS = [
  'progress',
  'run-for',
  'cycle',
  'program',
  'appliance-power',
  'now-playing',
  'playback',
  'volume',
  'source',
  'contact',
  'motion-trigger',
  'lock',
  'alarm',
  'fan',
  'vacuum',
  'vacuum-suction',
  'mower',
  'feeder',
  'fountain',
  'pump-cycle',
  'automation',
  'script',
  'do-not-disturb',
  'brightness',
  'color',
  'cover',
  'valve',
  'humidifier',
  'update',
  'button',
  'climate-mode',
  'climate-fan',
  'setpoint',
  'channel',
  'control',
  'circuit',
  'heat-pump-power',
  'system-mode',
] as const
export const HeroRowIdSchema = z.enum(HERO_ROW_IDS)
export type HeroRowId = z.infer<typeof HeroRowIdSchema>

/**
 * The label a row carries at its left ("Phase | value | action"), per row id: the
 * vocabulary of layout A, so no client names a row itself.
 */
export const HERO_ROW_LABELS: Readonly<Record<HeroRowId, HeroText>> = {
  progress: heroText('Progress', 'Avanzamento'),
  'run-for': heroText('Run for', 'Avvia per'),
  cycle: heroText('Cycle', 'Ciclo'),
  program: heroText('Program', 'Programma'),
  'appliance-power': heroText('Appliance', 'Elettrodomestico'),
  'now-playing': heroText('Now playing', 'In riproduzione'),
  playback: heroText('Playback', 'Riproduzione'),
  volume: heroText('Volume', 'Volume'),
  source: heroText('Source', 'Sorgente'),
  contact: heroText('Door', 'Porta'),
  'motion-trigger': heroText('Motion', 'Movimento'),
  lock: heroText('Lock', 'Serratura'),
  alarm: heroText('Alarm', 'Allarme'),
  fan: heroText('Fan', 'Ventola'),
  vacuum: heroText('Cleaning', 'Pulizia'),
  'vacuum-suction': heroText('Suction', 'Aspirazione'),
  mower: heroText('Mowing', 'Taglio'),
  feeder: heroText('Feed now', 'Eroga ora'),
  fountain: heroText('Pump', 'Pompa'),
  'pump-cycle': heroText('Pump cycle', 'Ciclo pompa'),
  automation: heroText('Automation', 'Automazione'),
  script: heroText('Script', 'Script'),
  'do-not-disturb': heroText('Do not disturb', 'Non disturbare'),
  brightness: heroText('Brightness', 'Luminosità'),
  color: heroText('Colour', 'Colore'),
  cover: heroText('Position', 'Posizione'),
  valve: heroText('Valve', 'Valvola'),
  humidifier: heroText('Humidifier', 'Umidificatore'),
  update: heroText('Firmware', 'Firmware'),
  button: heroText('Action', 'Azione'),
  'climate-mode': heroText('Mode', 'Modalità'),
  'climate-fan': heroText('Fan', 'Ventola'),
  setpoint: heroText('Setpoint', 'Temperatura'),
  channel: heroText('Channel', 'Canale'),
  control: heroText('Control', 'Controllo'),
  circuit: heroText('Circuit', 'Circuito'),
  'heat-pump-power': heroText('Power', 'Potenza'),
  'system-mode': heroText('Mode', 'Modalità'),
}

/** Argument values an action carries; the device id is added by the renderer. */
export type HeroScalar = string | number | boolean
/** A scalar, or a nested object of them (a cap input such as `{ color: { mode, hsv: { h, s, v } } }`). */
export type HeroArgValue = HeroScalar | { [key: string]: HeroArgValue }
export const HeroArgValueSchema: z.ZodType<HeroArgValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), HeroArgValueSchema)]),
)
export const HeroArgsSchema = z.record(z.string(), HeroArgValueSchema)
export type HeroArgs = z.infer<typeof HeroArgsSchema>

function setArgAt(args: HeroArgs, keys: readonly string[], value: HeroScalar): HeroArgs {
  const [head, ...rest] = keys
  if (head === undefined) return args
  if (rest.length === 0) return { ...args, [head]: value }
  const child = args[head]
  const base: HeroArgs = typeof child === 'object' ? child : {}
  return { ...args, [head]: setArgAt(base, rest, value) }
}

/**
 * `args` with the chosen value set at `path` (`level`, or `control.value` for a value
 * that lives inside a nested argument). The original is not touched; a renderer builds
 * the call of a slider or picker with this.
 */
export function heroArgsWithValue(args: HeroArgs, path: string, value: HeroScalar): HeroArgs {
  return setArgAt(args, path.split('.'), value)
}

/** A cap method called on the hero's device. */
export const HeroCallSchema = z.object({
  cap: z.string(),
  method: z.string(),
  args: HeroArgsSchema,
})
export type HeroCall = z.infer<typeof HeroCallSchema>

export const HeroConfirmSchema = z.enum(['off-while-running', 'unlock', 'install', 'press'])
export type HeroConfirm = z.infer<typeof HeroConfirmSchema>

export const HeroActionSchema = z.object({
  /** Unique within the model; the `gated` list and the specs name it. */
  id: z.string(),
  label: HeroTextSchema,
  icon: IconKeySchema,
  call: HeroCallSchema,
  emphasis: z.enum(['primary', 'normal']),
  /** Ask before running it. */
  confirm: HeroConfirmSchema.nullable(),
})
export type HeroAction = z.infer<typeof HeroActionSchema>

export const HeroControlSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), action: HeroActionSchema }),
  z.object({
    kind: z.literal('toggle'),
    id: z.string(),
    label: HeroTextSchema,
    /** `null` = not known; never drawn as off. */
    on: z.boolean().nullable(),
    turnOn: HeroActionSchema,
    turnOff: HeroActionSchema,
  }),
  z.object({
    kind: z.literal('slider'),
    id: z.string(),
    label: HeroTextSchema,
    /** `null` = the device has not reported a level: drawn as unknown. */
    value: z.number().nullable(),
    min: z.number(),
    max: z.number(),
    step: z.number(),
    unit: z.string(),
    call: HeroCallSchema,
    /** The argument that takes the chosen value. */
    valueArg: z.string(),
  }),
  z.object({
    kind: z.literal('picker'),
    id: z.string(),
    label: HeroTextSchema,
    current: z.string().nullable(),
    options: z.array(z.string()),
    /** A readable label per option value; an option without one is drawn as its raw value. */
    optionLabels: z.record(z.string(), HeroTextSchema).optional(),
    call: HeroCallSchema,
    valueArg: z.string(),
  }),
])
export type HeroControl = z.infer<typeof HeroControlSchema>

/** One value drawn as a pill: an icon, the words, a tone. `null` icon = text only. */
export interface HeroPill {
  readonly icon: IconKey | null
  readonly text: HeroText
  readonly tone: HeroTone
}
/** Declared by its interface: a `z.infer` of one more icon union pushes the cap's inferred type past what the compiler can print. */
export const HeroPillSchema: z.ZodType<HeroPill> = z.object({
  icon: IconKeySchema.nullable(),
  text: HeroTextSchema,
  tone: HeroToneSchema,
})

export const HeroRowSchema = z.object({
  id: HeroRowIdSchema,
  /** The row's own name when the kind's label would not tell rows of one kind apart (a circuit's label). */
  label: HeroTextSchema.optional(),
  /** A group header drawn above the row when it differs from the previous row's ("System"). */
  group: HeroTextSchema.optional(),
  /** Values drawn as pills across the row (a heat pump's powers). */
  pills: z.array(HeroPillSchema).optional(),
  icon: IconKeySchema,
  /** The row's status, in words. `null` = nothing to say. */
  status: HeroTextSchema.nullable(),
  controls: z.array(HeroControlSchema),
  /** A bar under the row's label, 0..1; `null` / absent = no bar. */
  progress: z.number().min(0).max(1).nullable().optional(),
})
export type HeroRow = z.infer<typeof HeroRowSchema>

export const HeroDetailSchema = z.object({
  label: HeroTextSchema,
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable(),
})
export type HeroDetail = z.infer<typeof HeroDetailSchema>

export const HeroBadgeSchema = z.object({
  id: z.enum(['battery', 'network-link', 'integration']),
  icon: IconKeySchema,
  tone: HeroToneSchema,
  /** Percent for a battery, link quality for a link; `null` = not known. */
  value: z.number().nullable(),
  label: HeroTextSchema,
})
export type HeroBadge = z.infer<typeof HeroBadgeSchema>

export const HeroRemoteSlotSchema = z.object({
  /** Saved commands; `null` = not known yet (the button still shows). */
  commands: z.number().int().nullable(),
})
export type HeroRemoteSlot = z.infer<typeof HeroRemoteSlotSchema>

export const HeroConsumableItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  level: z.number().nullable(),
  needsAttention: z.boolean(),
})
export type HeroConsumableItem = z.infer<typeof HeroConsumableItemSchema>

export const HeroConsumablesSlotSchema = z.object({
  items: z.array(HeroConsumableItemSchema),
  attention: z.number().int(),
})
export type HeroConsumablesSlot = z.infer<typeof HeroConsumablesSlotSchema>

export const HeroConsumptionSlotSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('power'),
    watts: z.number(),
    detail: z.array(HeroDetailSchema),
  }),
  z.object({
    kind: z.literal('running'),
    /** `null` = the device has not answered. */
    running: z.boolean().nullable(),
    since: z.number().nullable(),
    phase: z.string().nullable(),
    detail: z.array(HeroDetailSchema),
  }),
])
export type HeroConsumptionSlot = z.infer<typeof HeroConsumptionSlotSchema>

export const HeroOwnPowerSlotSchema = z.object({
  /** Which cap the power is switched through; the renderer never needs it. */
  source: z.enum(['switch', 'media-player', 'climate-control']),
  /** `null` = unknown, never off. */
  on: z.boolean().nullable(),
  assumed: z.boolean(),
  turnOn: HeroActionSchema,
  turnOff: HeroActionSchema,
})
export type HeroOwnPowerSlot = z.infer<typeof HeroOwnPowerSlotSchema>

export const HeroTimedRunSlotSchema = z.object({
  activeUntil: z.number().nullable(),
  quickRun: TimedRunQuickRunSchema,
  run: HeroActionSchema,
  cancel: HeroActionSchema,
  /**
   * Whole units left (the limit's unit, ceil). `null` while nothing is armed.
   * A number, not words: the row formats it, and a text here would not fit the
   * hero-layout declaration.
   */
  remaining: z.number().nullable(),
})
export type HeroTimedRunSlot = z.infer<typeof HeroTimedRunSlotSchema>

export const HeroPowerSupplySlotSchema = z.object({
  /** The plug's state; `null` = unknown, never off. */
  on: z.boolean().nullable(),
  /** Off asks for a confirmation while the device runs. */
  confirmOffWhileRunning: z.boolean(),
  running: z.boolean().nullable(),
  powerOn: HeroActionSchema,
  powerOff: HeroActionSchema,
  restart: HeroActionSchema,
})
export type HeroPowerSupplySlot = z.infer<typeof HeroPowerSupplySlotSchema>

const HeroStateBackdropSchema = z.object({
  token: z.enum(HERO_BACKGROUNDS),
  animation: z.enum(HERO_ANIMATIONS),
})

/**
 * One fact the layout prints: on the hero's top line, in a row's status line
 * (joined by " · ") or as a row's trailing fact. `id` names the kind so a client
 * can pick one without parsing the words.
 */
export const HERO_FACT_IDS = [
  'power',
  'energy',
  'battery',
  'link',
  'phase',
  'remaining',
  'volume',
  'source',
  'consumables',
  'since',
  'speed',
  'progress',
  'level',
  'last-run',
  'event',
  'members',
  'failures',
  'reading',
  'climate',
  'temperature',
  'humidity',
  'pressure',
  'air-quality',
  'illuminance',
  'valve',
] as const
export const HeroFactSchema = z.object({
  id: z.enum(HERO_FACT_IDS),
  icon: IconKeySchema.nullable(),
  text: HeroTextSchema,
  tone: HeroToneSchema,
})
export type HeroFact = z.infer<typeof HeroFactSchema>

/** A labelled value beside the scene. */
export const HeroSideTileSchema = z.object({
  label: HeroTextSchema,
  value: HeroTextSchema,
  tone: HeroToneSchema.optional(),
  /**
   * Epoch ms when the tile reads a clock time (an appliance's end): a client prints it in
   * the viewer's own time zone; `value` is the fallback for one that cannot.
   */
  at: z.number().optional(),
})
export type HeroSideTile = z.infer<typeof HeroSideTileSchema>

/** At most two tiles per side of the scene. */
export const HERO_SIDE_TILES_MAX = 2
export const HeroSideTilesSchema = z.object({
  left: z.array(HeroSideTileSchema).max(HERO_SIDE_TILES_MAX),
  right: z.array(HeroSideTileSchema).max(HERO_SIDE_TILES_MAX),
})
export type HeroSideTiles = z.infer<typeof HeroSideTilesSchema>

export const HeroBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('artwork'),
    url: z.string(),
    /** Drawn while the artwork loads or fails. */
    fallback: HeroStateBackdropSchema,
  }),
  z.object({ kind: z.literal('state'), ...HeroStateBackdropSchema.shape }),
])
export type HeroBackground = z.infer<typeof HeroBackgroundSchema>

export const HeroProvenanceSchema = z.object({
  partId: z.string(),
  cap: z.string(),
})
export type HeroProvenance = z.infer<typeof HeroProvenanceSchema>

export const HeroModelSchema = z.object({
  deviceId: z.number().int(),
  type: z.string(),
  role: z.string().nullable(),
  name: z.string(),
  state: HeroStateSchema,
  /** The state is the driver's own guess (infrared has no feedback). */
  stateAssumed: z.boolean(),
  look: StateLookSchema,
  background: HeroBackgroundSchema,
  /** Which animated picture the hero (and the list row) draws; its motion is `look.animation`. */
  scene: HeroSceneSchema,
  /** The top line's inline facts, in order; never wraps, so a client may cut the tail. */
  facts: z.array(HeroFactSchema),
  sideTiles: HeroSideTilesSchema,
  /** The status line under the main icon. */
  title: HeroTextSchema,
  /** The scene's top line when it says more than `title`; absent = draw the title. */
  caption: HeroTextSchema.optional(),
  badges: z.array(HeroBadgeSchema),
  remote: HeroRemoteSlotSchema.nullable(),
  /** The foot button that opens the device's history: "History", "Cycles", "Meals", "Access". */
  historyLabel: HeroTextSchema,
  consumables: HeroConsumablesSlotSchema.nullable(),
  consumption: HeroConsumptionSlotSchema.nullable(),
  ownPower: HeroOwnPowerSlotSchema.nullable(),
  timedRun: HeroTimedRunSlotSchema.nullable(),
  powerSupply: HeroPowerSupplySlotSchema.nullable(),
  rows: z.array(HeroRowSchema),
  /** Ids of parts that actuate the device, hidden from a session that may not act on it. */
  gated: z.array(z.string()),
  provenance: z.array(HeroProvenanceSchema),
})
export type HeroModel = z.infer<typeof HeroModelSchema>
