import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import type { ConsumableItem } from './consumables.cap.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Pet water-fountain cap. Models the telemetry and the control surface of a
 * circulating drinking fountain: how much water is in the tank, how much the
 * pet drank, whether the pump runs.
 *
 * It has no native vendor provider of its own: a fountain reaches CamStack as
 * a container of loose entities (a pump switch, two number boxes, a "filter
 * changed" button), and an operator BUILDS the device from them — a composed
 * device of this type (D659, D967). Every method is therefore a forward to ONE
 * method of ONE source entity, and every reading is a field derived from a
 * source entity; the provider-shaped interface below exists so the composed
 * device and any future native provider answer the same contract.
 *
 * Quantities are stored in the base unit of their kind (D944): volumes in
 * LITRES, durations in SECONDS, the tank level in percent. A source that
 * reports millilitres or minutes is converted in the composition's expression,
 * never here. Every reading may be `null`: a source that is offline or does
 * not report is unknown, never zero.
 *
 * The pump's on/off duty cycle is model-specific and lives in the optional
 * `pump-cycle` cap. The filter, the cleaning and the water change are not
 * fields of this cap: they are items of the `consumables` cap on the same
 * device (kind `wear`), reset by the same forward mechanism.
 */

export const PetFountainStatusSchema = z.object({
  /** Water in the tank, 0..100 (%). Null while the source has not reported. */
  waterLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Water in the tank, in litres. Null while the source has not reported. */
  waterVolume: z.number().min(0).nullable().meta(readingMeta('volume')),
  /** True when the tank is empty. Null while unknown. */
  empty: z.boolean().nullable(),
  /** True while the pump is running. Null while unknown. */
  pumpRunning: z.boolean().nullable(),
  /** Decoded fault message. Null means healthy; a non-null string is an active fault. */
  error: z.string().nullable(),
  /** Ms epoch when the slice was last refreshed. */
  lastFetchedAt: z.number(),
})

export type PetFountainStatus = z.infer<typeof PetFountainStatusSchema>

/** The key of the `consumables` item derived from the tank. */
export const PET_FOUNTAIN_WATER_KEY = 'water'

/**
 * The fountain's tank as a `consumables` item: a `supply` drawn as a `tank`.
 * The level is the fountain's `waterLevel`; the verdict is left to whoever
 * reads a level (the notification centre judges a level-only supply). Only a fountain that reports no level falls back to its `empty`
 * flag — a measurement that failed is `null`, never 0 (D393).
 */
export function petFountainWaterItem(
  status: Pick<PetFountainStatus, 'waterLevel' | 'empty'>,
): ConsumableItem {
  const verdict =
    status.waterLevel !== null || status.empty === null ? null : status.empty ? 'empty' : 'ok'
  return {
    key: PET_FOUNTAIN_WATER_KEY,
    label: 'Water',
    level: status.waterLevel,
    status: verdict,
    kind: 'supply',
    form: 'tank',
    lastResetAt: null,
    resettable: false,
  }
}

const DeviceIdSchema = z.number().int().nonnegative()

export const petFountainCapability = {
  name: 'pet-fountain',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.PetFountain],
  power: { kind: 'field', field: 'pumpRunning', set: 'setPump' },
  methods: {
    /** Start or stop the pump. */
    setPump: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'petFountain.pumpOn',
          label: t('Pump on', 'Pompa accesa'),
          phrase: t('Start the pump of {device}', 'Avvia la pompa di {device}'),
          icon: 'play',
          args: { on: true },
        },
        {
          id: 'petFountain.pumpOff',
          label: t('Pump off', 'Pompa spenta'),
          phrase: t('Stop the pump of {device}', 'Ferma la pompa di {device}'),
          icon: 'square',
          args: { on: false },
        },
      ],
    }),
  },
  status: {
    schema: PetFountainStatusSchema,
    kind: 'push',
  },
  /** Runtime-state slice — mirrored by the kernel; the hero card reads it whole. */
  runtimeState: PetFountainStatusSchema,

  /**
   * Runtime-state durability: **session** — live appliance state re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /** History (D850): recorded series. */
  history: {
    fields: {
      waterLevel: { kind: 'gauge', unit: '%', deadband: 1 },
      waterVolume: { kind: 'gauge', unit: 'L' },
    },
  },
  vocabulary: {
    noun: t('Pet fountain', 'Fontana per animali'),
    order: 2040,
    state: [
      {
        kind: 'boolean',
        field: 'empty',
        label: t('Tank empty', 'Serbatoio vuoto'),
        whenTrue: t(
          'When the tank of {device} is empty',
          'Quando il serbatoio di {device} è vuoto',
        ),
        whenFalse: t(
          'When the tank of {device} is refilled',
          'Quando il serbatoio di {device} viene riempito',
        ),
        icon: 'droplet',
      },
      {
        kind: 'numeric',
        field: 'waterLevel',
        quantity: t('the water level', 'il livello dell’acqua'),
        label: t('Water level', 'Livello dell’acqua'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IPetFountainProvider = InferProvider<typeof petFountainCapability>
