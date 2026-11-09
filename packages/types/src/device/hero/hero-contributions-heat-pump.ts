/**
 * The heat pump's contribution to a hero (D1026): the compressor scene, every
 * circuit as a row with its own label and icon, the powers as pills (the
 * instantaneous COP is "—" when it cannot be computed) and a "System" group with
 * one selector per mode. Values and their limits come from the slice, which the
 * gateway filled: a selector with no allowed value is not drawn, a missing
 * reading is never a 0 (D393).
 */
import {
  HeatPumpStatusSchema,
  heatPumpInstantCop,
  type HeatPumpCircuit,
  type HeatPumpOptionSetting,
  type HeatPumpStatus,
} from '../../capabilities/heat-pump-status.cap.js'
import { contribution, fact, reading, type HeroContribution } from './hero-contribution-kit.js'
import type { HeroFragment } from './hero-fragment.js'
import type { HeroControl, HeroFact, HeroPill, HeroRow, HeroSideTile } from './hero-model.js'
import { heroText, type HeroText } from './hero-text.js'
import { formatDegrees, thermalStatusText } from './climate-view.js'

const CAP = 'heat-pump-control'

const same = (text: string): HeroText => heroText(text, text)

/** The words of the values the gateway names; a value not listed is drawn as the gateway wrote it. */
const VALUE_LABELS: Readonly<Record<string, HeroText>> = {
  off: heroText('Off', 'Off'),
  on: heroText('On', 'On'),
  auto: heroText('Auto', 'Auto'),
  manual: heroText('Manual', 'Manuale'),
  low: heroText('Low', 'Bassa'),
  high: heroText('High', 'Alta'),
  eco: heroText('Eco', 'Eco'),
  heat: heroText('Heat', 'Caldo'),
  cool: heroText('Cool', 'Freddo'),
  heatCool: heroText('Heat/cool', 'Caldo/freddo'),
  ownprogram: heroText('Programme', 'Programma'),
}

function valueLabel(value: string): HeroText {
  const known = VALUE_LABELS[value]
  if (known !== undefined) return known
  const holiday = /^hm(\d+)$/.exec(value)
  if (holiday?.[1] !== undefined)
    return heroText(`Programme ${holiday[1]}`, `Programma ${holiday[1]}`)
  return same(value)
}

function optionLabels(allowed: readonly string[]): Readonly<Record<string, HeroText>> {
  return Object.fromEntries(allowed.map((value) => [value, valueLabel(value)]))
}

function picker(
  id: string,
  label: HeroText,
  setting: HeroOptionSettingView,
  method: string,
  args: Readonly<Record<string, string>>,
  valueArg = 'mode',
): HeroControl {
  return {
    kind: 'picker',
    id,
    label,
    current: setting.value,
    options: [...setting.allowed],
    optionLabels: optionLabels(setting.allowed),
    call: { cap: CAP, method, args: { ...args } },
    valueArg,
  }
}

type HeroOptionSettingView = HeatPumpOptionSetting

/** A selector exists only where the gateway named values to choose from. */
function choosable(setting: HeatPumpOptionSetting | null): setting is HeatPumpOptionSetting {
  return setting !== null && setting.allowed.length > 0
}

function circuitControl(circuit: HeatPumpCircuit): HeroControl | null {
  const args = { circuitId: circuit.id }
  if (circuit.kind === 'dhw' && choosable(circuit.temperatureLevel)) {
    return picker(
      `heat-pump.${circuit.id}.level`,
      heroText('Level', 'Livello'),
      circuit.temperatureLevel,
      'setDhwTemperatureLevel',
      args,
      'level',
    )
  }
  if (!choosable(circuit.operationMode)) return null
  const method = circuit.kind === 'dhw' ? 'setDhwOperationMode' : 'setCircuitOperationMode'
  return picker(
    `heat-pump.${circuit.id}.mode`,
    heroText('Mode', 'Modalità'),
    circuit.operationMode,
    method,
    args,
  )
}

/** A circuit with no reading is still a row: it shows that nothing is known, not nothing. */
const UNKNOWN_STATUS = same('—')

function circuitRow(circuit: HeatPumpCircuit): HeroRow {
  const control = circuitControl(circuit)
  const status = thermalStatusText(circuit.targetTemp, circuit.currentTemp) ?? UNKNOWN_STATUS
  return {
    id: 'circuit',
    label: same(circuit.label),
    icon: circuit.icon,
    status,
    controls: control === null ? [] : [control],
  }
}

const kilowatts = (watts: number): string => `${Number((watts / 1000).toFixed(2))} kW`

/** A COP that cannot be computed is still the pill: "—", never an absent reading (D393). */
function copPill(cop: number | null): HeroPill {
  if (cop === null) {
    return {
      icon: 'gauge',
      text: heroText('Instantaneous COP —', 'COP istantaneo —'),
      tone: 'muted',
    }
  }
  const text = String(Number(cop.toFixed(1)))
  return {
    icon: 'gauge',
    text: heroText(`Instantaneous COP ${text}`, `COP istantaneo ${text}`),
    tone: 'success',
  }
}

function powerPills(status: HeatPumpStatus): readonly HeroPill[] {
  const { thermalW, electricalW } = status.power
  const pills: HeroPill[] = []
  if (thermalW !== null) {
    pills.push({
      icon: 'flame',
      text: heroText(`Thermal ${kilowatts(thermalW)}`, `Termica ${kilowatts(thermalW)}`),
      tone: 'muted',
    })
  }
  if (electricalW !== null) {
    pills.push({
      icon: 'zap',
      text: heroText(`Electrical ${kilowatts(electricalW)}`, `Elettrica ${kilowatts(electricalW)}`),
      tone: 'muted',
    })
  }
  pills.push(copPill(heatPumpInstantCop(status.power)))
  return pills
}

interface SystemModeDef {
  readonly key: keyof HeatPumpStatus['system']
  readonly label: HeroText
  readonly icon: HeroRow['icon']
  readonly method: string
}

/** The independent system modes, in the order the card draws them. */
const SYSTEM_MODES: readonly SystemModeDef[] = [
  {
    key: 'silent',
    label: heroText('Silent', 'Silenzioso'),
    icon: 'volume-x',
    method: 'setSilentMode',
  },
  {
    key: 'away',
    label: heroText('Away', 'Assente'),
    icon: 'plane',
    method: 'setAwayMode',
  },
  {
    key: 'additionalHeater',
    label: heroText('Additional heater', 'Riscaldatore aggiuntivo'),
    icon: 'flame',
    method: 'setAdditionalHeaterMode',
  },
  {
    key: 'holiday',
    label: heroText('Holiday', 'Vacanza'),
    icon: 'tree-palm',
    method: 'setHolidayMode',
  },
]

const SYSTEM_GROUP = heroText('System', 'Sistema')

const PROGRAMME = /^hm\d+$/

/**
 * Holiday is two segments, off / programme. Choosing "programme" keeps the programme
 * that is set, else the first one the gateway allowed, so a write never leaves
 * `allowed`. The full hm1..hm8 pick is not in the hero (D1026). A holiday whose values
 * are not programmes keeps the plain selector.
 */
function holidayRow(def: SystemModeDef, setting: HeatPumpOptionSetting): HeroRow | null {
  if (!setting.allowed.includes('off')) return null
  const current = setting.value !== null && PROGRAMME.test(setting.value) ? setting.value : null
  const programme = current ?? setting.allowed.find((v) => PROGRAMME.test(v))
  if (programme === undefined) return null
  const control = picker(
    'heat-pump.system.holiday',
    def.label,
    { value: setting.value, allowed: ['off', programme] },
    def.method,
    {},
  )
  const number = programme.slice(2)
  return {
    id: 'system-mode',
    label: def.label,
    group: SYSTEM_GROUP,
    icon: def.icon,
    status: current === null ? null : heroText(`Programme ${number}`, `Programma ${number}`),
    controls: [
      control.kind === 'picker'
        ? {
            ...control,
            optionLabels: {
              off: heroText('Off', 'Off'),
              [programme]: heroText('Programme', 'Programma'),
            },
          }
        : control,
    ],
  }
}

function systemRows(status: HeatPumpStatus): readonly HeroRow[] {
  const rows: HeroRow[] = []
  for (const def of SYSTEM_MODES) {
    const setting = status.system[def.key]
    if (!choosable(setting)) continue
    if (def.key === 'holiday') {
      const holiday = holidayRow(def, setting)
      if (holiday !== null) {
        rows.push(holiday)
        continue
      }
    }
    rows.push({
      id: 'system-mode',
      label: def.label,
      group: SYSTEM_GROUP,
      icon: def.icon,
      status: null,
      controls: [picker(`heat-pump.system.${def.key}`, def.label, setting, def.method, {})],
    })
  }
  return rows
}

function tile(en: string, it: string, value: string): HeroSideTile {
  return { label: heroText(en, it), value: same(value) }
}

function tilesOf(status: HeatPumpStatus): {
  left: HeroSideTile[]
  right: HeroSideTile[]
} {
  const { supply, return: back, outdoor } = status.temperatures
  const left: HeroSideTile[] = []
  const right: HeroSideTile[] = []
  if (supply !== null) left.push(tile('Supply', 'Mandata', formatDegrees(supply)))
  if (back !== null) left.push(tile('Return', 'Ritorno', formatDegrees(back)))
  if (outdoor !== null) right.push(tile('Outdoor', 'Esterna', formatDegrees(outdoor)))
  if (status.waterPressureBar !== null) {
    right.push(tile('Pressure', 'Pressione', `${Number(status.waterPressureBar.toFixed(1))} bar`))
  }
  return { left, right }
}

function isRunning(status: HeatPumpStatus): boolean | null {
  const { compressorPct, electricalW } = status.power
  if (compressorPct !== null) return compressorPct > 0
  if (electricalW !== null) return electricalW > 0
  return null
}

const heatPumpContribution = contribution(
  'heat-pump-status',
  HeatPumpStatusSchema,
  (slice): HeroFragment => {
    if (slice === undefined) return { reading: reading('climate-control', 'unknown') }
    const running = isRunning(slice)
    const facts: HeroFact[] = []
    if (slice.power.electricalW !== null) {
      facts.push(fact('power', 'zap', same(`${Math.round(slice.power.electricalW)} W`)))
    }
    if (slice.power.compressorPct !== null) {
      facts.push(
        fact(
          'level',
          'gauge',
          heroText(
            `Compressor ${Math.round(slice.power.compressorPct)} %`,
            `Compressore ${Math.round(slice.power.compressorPct)} %`,
          ),
        ),
      )
    }
    const charging = slice.circuits.find((c) => c.active === true)
    const tiles = tilesOf(slice)
    const pills = powerPills(slice)
    const rows: HeroRow[] = [
      ...slice.circuits.map(circuitRow),
      ...(pills.length === 0
        ? []
        : [
            {
              id: 'heat-pump-power' as const,
              icon: 'zap' as const,
              status: null,
              controls: [],
              pills: [...pills],
            },
          ]),
      ...systemRows(slice),
    ]
    return {
      reading: reading(
        'climate-control',
        running === true ? 'running' : running === false ? 'idle' : 'on',
      ),
      title: heroText('Heat pump', 'Pompa di calore'),
      ...(charging === undefined
        ? {}
        : {
            caption: heroText(
              `${charging.label} · heating`.toUpperCase(),
              `${charging.label} · in riscaldamento`.toUpperCase(),
            ),
          }),
      facts,
      ...(tiles.left.length === 0 && tiles.right.length === 0 ? {} : { tiles }),
      ...(slice.power.electricalW === null
        ? {}
        : {
            consumption: {
              priority: 1,
              slot: {
                kind: 'power' as const,
                watts: slice.power.electricalW,
                detail:
                  slice.power.thermalW === null
                    ? []
                    : [
                        {
                          label: heroText('Thermal', 'Termica'),
                          value: Math.round(slice.power.thermalW),
                          unit: 'W',
                        },
                      ],
              },
            },
          }),
      rows,
    }
  },
)

export const HEAT_PUMP_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  'heat-pump-status': heatPumpContribution,
}
