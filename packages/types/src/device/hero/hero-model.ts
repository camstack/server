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
import { IconKeySchema } from '../icon-catalog.js'
import {
  HERO_ANIMATIONS,
  HERO_BACKGROUNDS,
  HeroStateSchema,
  HeroToneSchema,
  StateLookSchema,
} from './hero-state.js'
import { HeroSceneSchema } from './hero-scene.js'
import { HeroTextSchema } from './hero-text.js'

/** The rows a layout may carry. Each is built from the caps the device is bound to. */
export const HERO_ROW_IDS = [
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
] as const
export const HeroRowIdSchema = z.enum(HERO_ROW_IDS)
export type HeroRowId = z.infer<typeof HeroRowIdSchema>

/** Argument values an action carries; the device id is added by the renderer. */
export const HeroArgsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
export type HeroArgs = z.infer<typeof HeroArgsSchema>

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
    call: HeroCallSchema,
    valueArg: z.string(),
  }),
])
export type HeroControl = z.infer<typeof HeroControlSchema>

export const HeroRowSchema = z.object({
  id: HeroRowIdSchema,
  icon: IconKeySchema,
  /** The row's status, in words. `null` = nothing to say. */
  status: HeroTextSchema.nullable(),
  controls: z.array(HeroControlSchema),
})
export type HeroRow = z.infer<typeof HeroRowSchema>

export const HeroDetailSchema = z.object({
  label: HeroTextSchema,
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable(),
})
export type HeroDetail = z.infer<typeof HeroDetailSchema>

export const HeroBadgeSchema = z.object({
  id: z.enum(['battery', 'network-link']),
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
  source: z.enum(['switch', 'media-player']),
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

export const HeroProvenanceSchema = z.object({ partId: z.string(), cap: z.string() })
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
  badges: z.array(HeroBadgeSchema),
  remote: HeroRemoteSlotSchema.nullable(),
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
