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

/**
 * The circuit a per-circuit step acts on, offered from the circuits
 * `heat-pump-status` reports for the same device (D1050). Mode values differ
 * per circuit and per gateway (`allowed` on each circuit), so a mode is
 * offered as text and the provider refuses a value the circuit does not take.
 */
const HEATING_CIRCUIT = {
  key: 'circuitId',
  label: t('Circuit', 'Circuito'),
  offer: {
    kind: 'dynamic',
    from: 'status',
    cap: 'heat-pump-status',
    field: 'circuits',
    valueKey: 'id',
    labelKey: 'label',
    where: { key: 'kind', equals: 'heating' },
  },
} as const
const HOT_WATER_CIRCUIT = {
  ...HEATING_CIRCUIT,
  label: t('Hot water circuit', 'Circuito acqua calda'),
  offer: { ...HEATING_CIRCUIT.offer, where: { key: 'kind', equals: 'dhw' } },
} as const
const MODE_ARG = { key: 'mode', label: t('Mode', 'Modalità'), offer: { kind: 'text' } } as const
const LEVEL_ARG = { key: 'level', label: t('Level', 'Livello'), offer: { kind: 'text' } } as const
const TEMP_ARG = {
  key: 'temp',
  label: t('Temperature', 'Temperatura'),
  offer: { kind: 'number', step: 0.5, unit: '°C' },
} as const
const MINUTES_ARG = {
  key: 'minutes',
  label: t('Minutes', 'Minuti'),
  offer: { kind: 'number', min: 1, step: 1, unit: 'min' },
} as const

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
      actions: [
        {
          id: 'heatPump.circuitOperationMode',
          label: t('Set circuit operation mode', 'Imposta la modalità del circuito'),
          phrase: t(
            'Set {circuitId} of {device} to {mode}',
            'Imposta {circuitId} di {device} su {mode}',
          ),
          icon: 'thermometer',
          openArgs: [HEATING_CIRCUIT, MODE_ARG],
        },
      ],
    }),
    setCircuitHeatCoolMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.circuitHeatCoolMode',
          label: t('Set circuit heat / cool', 'Imposta caldo / freddo del circuito'),
          phrase: t(
            'Set {circuitId} of {device} to {mode}',
            'Imposta {circuitId} di {device} su {mode}',
          ),
          icon: 'sun-snow',
          openArgs: [HEATING_CIRCUIT, MODE_ARG],
        },
      ],
    }),
    setCircuitSummerWinter: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.circuitSummerWinter',
          label: t('Set circuit summer / winter', 'Imposta estate / inverno del circuito'),
          phrase: t(
            'Set {circuitId} of {device} to {mode}',
            'Imposta {circuitId} di {device} su {mode}',
          ),
          icon: 'sun',
          openArgs: [HEATING_CIRCUIT, MODE_ARG],
        },
      ],
    }),
    setCircuitComfortSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.circuitComfortSetpoint',
          label: t('Set comfort temperature', 'Imposta la temperatura comfort'),
          phrase: t(
            'Set the comfort temperature of {circuitId} on {device} to {temp}',
            'Imposta la temperatura comfort di {circuitId} su {device} a {temp}',
          ),
          icon: 'thermometer-sun',
          openArgs: [HEATING_CIRCUIT, TEMP_ARG],
        },
      ],
    }),
    setCircuitEcoSetpoint: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.circuitEcoSetpoint',
          label: t('Set eco temperature', 'Imposta la temperatura eco'),
          phrase: t(
            'Set the eco temperature of {circuitId} on {device} to {temp}',
            'Imposta la temperatura eco di {circuitId} su {device} a {temp}',
          ),
          icon: 'leaf',
          openArgs: [HEATING_CIRCUIT, TEMP_ARG],
        },
      ],
    }),
    setCircuitMaxFlowTemp: method(z.object({ deviceId, circuitId, temp }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.circuitMaxFlowTemp',
          label: t('Set maximum flow temperature', 'Imposta la temperatura massima di mandata'),
          phrase: t(
            'Set the maximum flow temperature of {circuitId} on {device} to {temp}',
            'Imposta la temperatura massima di mandata di {circuitId} su {device} a {temp}',
          ),
          icon: 'flame',
          openArgs: [HEATING_CIRCUIT, TEMP_ARG],
        },
      ],
    }),
    // Hot water.
    setDhwOperationMode: method(z.object({ deviceId, circuitId, mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.dhwOperationMode',
          label: t('Set hot water mode', 'Imposta la modalità acqua calda'),
          phrase: t(
            'Set hot water {circuitId} of {device} to {mode}',
            "Imposta l'acqua calda {circuitId} di {device} su {mode}",
          ),
          icon: 'shower-head',
          openArgs: [HOT_WATER_CIRCUIT, MODE_ARG],
        },
      ],
    }),
    setDhwTemperatureLevel: method(z.object({ deviceId, circuitId, level: mode }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.dhwTemperatureLevel',
          label: t('Set hot water level', 'Imposta il livello acqua calda'),
          phrase: t(
            'Set hot water {circuitId} of {device} to level {level}',
            "Imposta l'acqua calda {circuitId} di {device} al livello {level}",
          ),
          icon: 'droplet',
          openArgs: [HOT_WATER_CIRCUIT, LEVEL_ARG],
        },
      ],
    }),
    setDhwChargeDuration: method(
      z.object({ deviceId, circuitId, minutes: z.number().int().positive() }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'heatPump.dhwChargeDuration',
            label: t('Set hot water charge duration', 'Imposta la durata della carica acqua calda'),
            phrase: t(
              'Set the charge of hot water {circuitId} on {device} to {minutes} min',
              "Imposta la carica dell'acqua calda {circuitId} di {device} a {minutes} min",
            ),
            icon: 'timer',
            openArgs: [HOT_WATER_CIRCUIT, MINUTES_ARG],
          },
        ],
      },
    ),
    /** Start an extra-hot-water charge now: an action, not a stored mode. */
    startExtraHotWater: method(z.object({ deviceId, circuitId }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'heatPump.extraHotWater',
          label: t('Start extra hot water', 'Avvia acqua calda extra'),
          phrase: t(
            'Start an extra hot water charge of {circuitId} on {device}',
            'Avvia una carica extra di acqua calda {circuitId} su {device}',
          ),
          icon: 'droplets',
          openArgs: [HOT_WATER_CIRCUIT],
        },
      ],
    }),
  },
  vocabulary: {
    noun: t('Heat pump settings', 'Impostazioni pompa di calore'),
    order: 4010,
  },
} as const satisfies CapabilityDefinition

export type IHeatPumpControlProvider = InferProvider<typeof heatPumpControlCapability>
