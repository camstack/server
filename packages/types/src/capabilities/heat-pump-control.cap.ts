import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Heat pump settable surface (D1026): one typed method per parameter, never a
 * generic `set(key, value)`. The values a mode takes and the limits of a number
 * are the ones `heat-pump-status` carries (`allowed`, `min`, `max`, `step`),
 * read from the gateway; a provider refuses a value outside them. The state is
 * `heat-pump-status` — this cap has none.
 */

const deviceId = z.number().int().nonnegative()
const circuitId = z.string().min(1)
const mode = z.string().min(1)
const temp = z.number().finite()

export const heatPumpControlCapability = {
  name: 'heat-pump-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.HeatPump],
  methods: {
    // System modes — each independent, each with its real values.
    /** off / auto / on. */
    setSilentMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.silent',
          label: t('Set silent mode', 'Imposta la modalità silenziosa'),
          phrase: t(
            'Set silent mode of {device} to {mode}',
            'Imposta la modalità silenziosa di {device} su {mode}',
          ),
          icon: 'volume-x',
          openArgs: [
            {
              key: 'mode',
              label: t('Silent mode', 'Modalità silenziosa'),
              offer: {
                kind: 'enum',
                values: [
                  { value: 'off', label: t('Off', 'Off') },
                  { value: 'auto', label: t('Auto', 'Auto') },
                  { value: 'on', label: t('On', 'On') },
                ],
              },
            },
          ],
        },
      ],
    }),
    /** off / on. */
    setAwayMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.away',
          label: t('Set away mode', 'Imposta la modalità assente'),
          phrase: t(
            'Set away mode of {device} to {mode}',
            'Imposta la modalità assente di {device} su {mode}',
          ),
          icon: 'plane',
          openArgs: [
            {
              key: 'mode',
              label: t('Away mode', 'Modalità assente'),
              offer: {
                kind: 'enum',
                values: [
                  { value: 'off', label: t('Off', 'Off') },
                  { value: 'on', label: t('On', 'On') },
                ],
              },
            },
          ],
        },
      ],
    }),
    /** off / manual / auto. */
    setAdditionalHeaterMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.additionalHeater',
          label: t('Set additional heater', 'Imposta il riscaldatore aggiuntivo'),
          phrase: t(
            'Set the additional heater of {device} to {mode}',
            'Imposta il riscaldatore aggiuntivo di {device} su {mode}',
          ),
          icon: 'flame',
          openArgs: [
            {
              key: 'mode',
              label: t('Additional heater', 'Riscaldatore aggiuntivo'),
              offer: {
                kind: 'enum',
                values: [
                  { value: 'off', label: t('Off', 'Off') },
                  { value: 'manual', label: t('Manual', 'Manuale') },
                  { value: 'auto', label: t('Auto', 'Auto') },
                ],
              },
            },
          ],
        },
      ],
    }),
    /** off / hm1 .. hm8 (the programmes the gateway lists). */
    setHolidayMode: method(z.object({ deviceId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.holiday',
          label: t('Set holiday mode', 'Imposta la modalità vacanza'),
          phrase: t(
            'Set holiday mode of {device} to {mode}',
            'Imposta la modalità vacanza di {device} su {mode}',
          ),
          icon: 'tree-palm',
          openArgs: [
            {
              key: 'mode',
              label: t('Holiday programme', 'Programma vacanza'),
              offer: {
                kind: 'enum',
                values: [
                  { value: 'off', label: t('Off', 'Off') },
                  { value: 'hm1', label: t('Programme 1', 'Programma 1') },
                  { value: 'hm2', label: t('Programme 2', 'Programma 2') },
                  { value: 'hm3', label: t('Programme 3', 'Programma 3') },
                  { value: 'hm4', label: t('Programme 4', 'Programma 4') },
                  { value: 'hm5', label: t('Programme 5', 'Programma 5') },
                  { value: 'hm6', label: t('Programme 6', 'Programma 6') },
                  { value: 'hm7', label: t('Programme 7', 'Programma 7') },
                  { value: 'hm8', label: t('Programme 8', 'Programma 8') },
                ],
              },
            },
          ],
        },
      ],
    }),
    // Per circuit.
    setCircuitOperationMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setCircuitHeatCoolMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setCircuitSummerWinter: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setCircuitComfortSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setCircuitEcoSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setCircuitMaxFlowTemp: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    // Hot water.
    setDhwOperationMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setDhwTemperatureLevel: method(z.object({ deviceId, circuitId, level: mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
    setDhwChargeDuration: method(
      z.object({ deviceId, circuitId, minutes: z.number().int().positive() }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
      },
    ),
    /** Start an extra-hot-water charge now: an action, not a stored mode. */
    startExtraHotWater: method(z.object({ deviceId, circuitId }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      notOperatorFacing: 'Needs a circuit: set from the device page, not offered to automations',
    }),
  },
  vocabulary: {
    noun: t('Heat pump settings', 'Impostazioni pompa di calore'),
    order: 4010,
  },
} as const satisfies CapabilityDefinition

export type IHeatPumpControlProvider = InferProvider<typeof heatPumpControlCapability>
