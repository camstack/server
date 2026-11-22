import { z } from 'zod'
import { t } from '../device/cap-vocabulary/l10n.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import {
  type CapabilityDefinition,
  type InferProvider,
  optionalMethod,
} from './capability-definition.js'

/**
 * A road vehicle reached through its maker's connected-car account: the
 * readings the car reports about itself, read-only. Where it is lives in
 * `location`, what it burns or wears in `consumables`, whether it is locked in
 * its `lock-control` child and its cabin climate in a `climate-control` child.
 *
 * Every reading is nullable: a car that does not report a value is UNKNOWN,
 * never 0 or false (D393). Lengths are metres and voltages volts (D944).
 *
 * Not in the cap, on purpose: `locked` (the lock child), fuel (consumables),
 * position (`location`), tyre PRESSURES (a vendor that reports them adds a
 * field), and any "anything open" aggregate: a stored derivation is a second
 * copy of the fields it derives from.
 */

/** `true` = open. Null = the car does not say. */
const OpeningSchema = z.boolean().nullable()

/** The four wheel positions, each an opening. */
export const VehicleWheelOpeningsSchema = z.object({
  frontLeft: OpeningSchema,
  frontRight: OpeningSchema,
  rearLeft: OpeningSchema,
  rearRight: OpeningSchema,
})
export type VehicleWheelOpenings = z.infer<typeof VehicleWheelOpeningsSchema>

/** Same four keys; `true` = the car raises a pressure warning for that wheel. */
export const VehicleTyreWarningsSchema = z.object({
  frontLeft: z.boolean().nullable(),
  frontRight: z.boolean().nullable(),
  rearLeft: z.boolean().nullable(),
  rearRight: z.boolean().nullable(),
})
export type VehicleTyreWarnings = z.infer<typeof VehicleTyreWarningsSchema>

export const VehicleStatusSchema = z.object({
  /** Total distance driven, metres. */
  odometer: z
    .number()
    .nonnegative()
    .nullable()
    .meta(readingMeta('length', { label: 'Distance driven' })),
  /** Distance the car says it can still drive on what it carries, metres. */
  range: z
    .number()
    .nonnegative()
    .nullable()
    .meta(readingMeta('length', { label: 'Range' })),
  engineOn: z.boolean().nullable(),
  doors: VehicleWheelOpeningsSchema,
  windows: VehicleWheelOpeningsSchema,
  trunkOpen: OpeningSchema,
  hoodOpen: OpeningSchema,
  sunroofOpen: OpeningSchema,
  tyreWarnings: VehicleTyreWarningsSchema,
  /** The 12 V auxiliary battery. Never the `battery` cap (that is the traction pack). */
  auxBatteryLevel: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .meta(readingMeta('percentage', { label: '12 V battery' })),
  auxBatteryVoltage: z
    .number()
    .nonnegative()
    .nullable()
    .meta(readingMeta('voltage', { label: '12 V voltage' })),
  /** Ms epoch the CAR last reported to its maker's cloud. Null = the cloud does not say. */
  reportedAt: z.number().nullable(),
  /** Ms epoch the status last changed. */
  lastChangedAt: z.number(),
})
export type VehicleStatus = z.infer<typeof VehicleStatusSchema>

const UNKNOWN_OPENINGS: VehicleWheelOpenings = {
  frontLeft: null,
  frontRight: null,
  rearLeft: null,
  rearRight: null,
}

/** Seed status: the car has told us nothing yet. */
export function emptyVehicleStatus(now: number = 0): VehicleStatus {
  return {
    odometer: null,
    range: null,
    engineOn: null,
    doors: { ...UNKNOWN_OPENINGS },
    windows: { ...UNKNOWN_OPENINGS },
    trunkOpen: null,
    hoodOpen: null,
    sunroofOpen: null,
    tyreWarnings: { ...UNKNOWN_OPENINGS },
    auxBatteryLevel: null,
    auxBatteryVoltage: null,
    reportedAt: null,
    lastChangedAt: now,
  }
}

/**
 * Why a forced refresh was refused. Waking the car spends the maker's daily
 * quota, so an expected refusal is a typed answer, never a throw.
 */
export const VEHICLE_REFRESH_REFUSALS = [
  'not-supported', // the provider cannot wake this car
  'budget-exhausted', // the provider's daily allowance for forced refreshes is spent
  'in-progress', // a forced refresh is already running
  'too-soon', // the last one finished less than the provider's minimum gap ago
  'vehicle-unreachable', // the cloud answered that the car did not respond
  'account-error', // login or session refused; no retry loop
] as const
export const VehicleRefreshRefusalSchema = z.enum(VEHICLE_REFRESH_REFUSALS)
export type VehicleRefreshRefusal = z.infer<typeof VehicleRefreshRefusalSchema>

export const VehicleRefreshResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), reportedAt: z.number().nullable() }),
  z.object({
    ok: z.literal(false),
    reason: VehicleRefreshRefusalSchema,
    /** Ms epoch a retry may succeed, when the provider knows (budget reset, gap end). */
    retryAt: z.number().nullable(),
  }),
])
export type VehicleRefreshResult = z.infer<typeof VehicleRefreshResultSchema>

export const vehicleCapability = {
  name: 'vehicle',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Vehicle],
  methods: {
    /**
     * Ask the car for fresh data. Admin-only: each call spends a scarce shared
     * quota. A provider that cannot wake the car does not implement it.
     */
    requestRefresh: optionalMethod(
      z.object({ deviceId: z.number().int().nonnegative() }),
      VehicleRefreshResultSchema,
      {
        kind: 'mutation',
        auth: 'admin',
        actions: [
          {
            id: 'vehicle.requestRefresh',
            label: t('Refresh from the car', "Aggiorna dall'auto"),
            phrase: t('Ask {device} for fresh data', 'Chiedi dati aggiornati a {device}'),
            icon: 'refresh-cw',
          },
        ],
      },
    ),
  },
  status: {
    schema: VehicleStatusSchema,
    kind: 'push',
    empty: emptyVehicleStatus(),
  },
  runtimeState: VehicleStatusSchema.extend({ lastFetchedAt: z.number() }),
  /**
   * Runtime-state durability: **restored** — nothing else holds the last cloud
   * read, and the cloud is rate-limited, so a restart must not blank the car
   * (D642). A restored value is the previous report; `reportedAt` says when.
   */
  durability: 'restored',
  /**
   * History (D850): the odometer is a monotonic hardware meter, so it is a
   * `counter` (distance per day and month comes free). Windows and the sunroof
   * are not recorded: five more series of low value; `reportedAt` is a clock.
   */
  history: {
    primary: 'range',
    priority: 30,
    fields: {
      odometer: { kind: 'counter', unit: 'm', displayName: 'Distance driven' },
      range: { kind: 'gauge', unit: 'm', deadband: 1000, displayName: 'Range' },
      engineOn: { kind: 'boolean', displayName: 'Engine' },
      auxBatteryLevel: { kind: 'gauge', unit: '%', deadband: 1, displayName: '12 V battery' },
      auxBatteryVoltage: { kind: 'gauge', unit: 'V', deadband: 0.1, displayName: '12 V voltage' },
      'doors.frontLeft': { kind: 'boolean', displayName: 'Front left door' },
      'doors.frontRight': { kind: 'boolean', displayName: 'Front right door' },
      'doors.rearLeft': { kind: 'boolean', displayName: 'Rear left door' },
      'doors.rearRight': { kind: 'boolean', displayName: 'Rear right door' },
      'tyreWarnings.frontLeft': { kind: 'boolean', displayName: 'Front left tyre warning' },
      'tyreWarnings.frontRight': { kind: 'boolean', displayName: 'Front right tyre warning' },
      'tyreWarnings.rearLeft': { kind: 'boolean', displayName: 'Rear left tyre warning' },
      'tyreWarnings.rearRight': { kind: 'boolean', displayName: 'Rear right tyre warning' },
      trunkOpen: { kind: 'boolean', displayName: 'Trunk' },
      hoodOpen: { kind: 'boolean', displayName: 'Hood' },
    },
  },
  /** Clocks, not content: a re-read that changed no reading costs no commit. */
  volatileStateFields: ['reportedAt', 'lastChangedAt', 'lastFetchedAt'],
  vocabulary: {
    noun: t('Vehicle', 'Veicolo'),
    order: 2190,
    // State triggers name a TOP-LEVEL status field, so the nested per-door and
    // per-tyre booleans have no trigger of their own; they are still recorded.
    state: [
      {
        kind: 'boolean',
        field: 'engineOn',
        label: t('Engine on', 'Motore acceso'),
        whenTrue: t("When {device}'s engine starts", 'Quando il motore di {device} si avvia'),
        whenFalse: t("When {device}'s engine stops", 'Quando il motore di {device} si spegne'),
        icon: 'car',
      },
      {
        kind: 'boolean',
        field: 'trunkOpen',
        label: t('Trunk open', 'Bagagliaio aperto'),
        whenTrue: t("When {device}'s trunk opens", 'Quando il bagagliaio di {device} si apre'),
        whenFalse: t("When {device}'s trunk closes", 'Quando il bagagliaio di {device} si chiude'),
        icon: 'car',
      },
      {
        kind: 'boolean',
        field: 'hoodOpen',
        label: t('Hood open', 'Cofano aperto'),
        whenTrue: t("When {device}'s hood opens", 'Quando il cofano di {device} si apre'),
        whenFalse: t("When {device}'s hood closes", 'Quando il cofano di {device} si chiude'),
        icon: 'car',
      },
      {
        kind: 'numeric',
        field: 'range',
        quantity: t('the range', "l'autonomia"),
        label: t('Range', 'Autonomia'),
        unit: 'm',
        icon: 'gauge',
      },
      {
        kind: 'numeric',
        field: 'auxBatteryLevel',
        quantity: t('the 12 V battery level', 'il livello della batteria a 12 V'),
        label: t('12 V battery', 'Batteria a 12 V'),
        unit: '%',
        icon: 'battery',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IVehicleProvider = InferProvider<typeof vehicleCapability>
