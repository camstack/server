import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

export const HeatingValveStatusSchema = z.object({
  /** Radiator valve opening 0 (closed) .. 100 (open). Null = not yet known. */
  position: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Ms epoch when the slice was last updated (push or poll). */
  lastFetchedAt: z.number(),
})

export type HeatingValveStatus = z.infer<typeof HeatingValveStatusSchema>

export const heatingValveCapability = {
  name: 'heating-valve',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Climate],
  methods: {},
  status: {
    schema: HeatingValveStatusSchema,
    kind: 'push',
  },
  runtimeState: HeatingValveStatusSchema,
  durability: 'session',
  history: {
    fields: {
      position: { kind: 'gauge', unit: '%', deadband: 1 },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
  vocabulary: {
    noun: t('Radiator valve', 'Valvola termostatica'),
    order: 1110,
    state: [
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the valve opening', 'l’apertura della valvola'),
        label: t('Valve opening', 'Apertura della valvola'),
        unit: '%',
        icon: 'heater',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IHeatingValveProvider = InferProvider<typeof heatingValveCapability>
