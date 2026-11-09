/**
 * The heat pump (D1026): its system modes are phrased for automations, each with the
 * values the gateway really accepts; the per-circuit parameters need a circuit and are
 * set from the device page.
 */
import { t } from '../l10n.js'
import type { CapVocabularySlice, VocabChoice } from '../types.js'

type HeatPumpCap = 'heat-pump-status' | 'heat-pump-control'

const OFF: VocabChoice = { value: 'off', label: t('Off', 'Off') }
const AUTO: VocabChoice = { value: 'auto', label: t('Auto', 'Auto') }
const ON: VocabChoice = { value: 'on', label: t('On', 'On') }
const MANUAL: VocabChoice = { value: 'manual', label: t('Manual', 'Manuale') }
const HOLIDAY_PROGRAMMES: readonly VocabChoice[] = [
  OFF,
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (n): VocabChoice => ({
      value: `hm${n}`,
      label: t(`Programme ${n}`, `Programma ${n}`),
    }),
  ),
]

const PER_CIRCUIT = 'Needs a circuit: set from the device page, not offered to automations'

export const HEAT_PUMP_CAP_VOCABULARY: CapVocabularySlice<HeatPumpCap> = {
  'heat-pump-status': {
    scope: 'device',
    noun: t('Heat pump', 'Pompa di calore'),
  },
  'heat-pump-control': {
    scope: 'device',
    noun: t('Heat pump settings', 'Impostazioni pompa di calore'),
    actions: [
      {
        id: 'heatPump.silent',
        method: 'setSilentMode',
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
            offer: { kind: 'enum', values: [OFF, AUTO, ON] },
          },
        ],
      },
      {
        id: 'heatPump.away',
        method: 'setAwayMode',
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
            offer: { kind: 'enum', values: [OFF, ON] },
          },
        ],
      },
      {
        id: 'heatPump.additionalHeater',
        method: 'setAdditionalHeaterMode',
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
            offer: { kind: 'enum', values: [OFF, MANUAL, AUTO] },
          },
        ],
      },
      {
        id: 'heatPump.holiday',
        method: 'setHolidayMode',
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
            offer: { kind: 'enum', values: HOLIDAY_PROGRAMMES },
          },
        ],
      },
    ],
    notOperatorFacing: {
      setCircuitOperationMode: PER_CIRCUIT,
      setCircuitHeatCoolMode: PER_CIRCUIT,
      setCircuitSummerWinter: PER_CIRCUIT,
      setCircuitComfortSetpoint: PER_CIRCUIT,
      setCircuitEcoSetpoint: PER_CIRCUIT,
      setCircuitMaxFlowTemp: PER_CIRCUIT,
      setDhwOperationMode: PER_CIRCUIT,
      setDhwTemperatureLevel: PER_CIRCUIT,
      setDhwChargeDuration: PER_CIRCUIT,
      startExtraHotWater: PER_CIRCUIT,
    },
  },
}
