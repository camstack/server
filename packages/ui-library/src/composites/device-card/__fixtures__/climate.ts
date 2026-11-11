/** The climate page of the approved mockup: its nine role variants and the horizontal one. */
import type { ClimateActivity } from '../scenes/climate/model'
import type { ClimateRole } from '../illustrations/ClimateRoleGlyph'
import type { MenuOption } from '../parts/MenuButton'
import type { CardOrientation } from '../shell/model'
import type { ClimateCardModel, ClimateChoice } from '../scenes/climate/model'
import { mockupCommon } from './common'

export interface ClimateFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: ClimateCardModel
}

const MODE_GLYPH: Readonly<Record<string, MenuOption['glyph']>> = {
  Auto: 'auto',
  Freddo: 'cool',
  Caldo: 'heat',
  Deumidifica: 'dry',
  Ventola: 'fanOnly',
  Spento: 'power',
}

function choice(value: string, options: readonly string[]): ClimateChoice {
  return {
    value,
    options: options.map((label) => {
      const glyph = MODE_GLYPH[label]
      return glyph === undefined ? { id: label, label } : { id: label, label, glyph }
    }),
  }
}

const MODES = ['Auto', 'Freddo', 'Caldo', 'Deumidifica', 'Ventola']
const FANS = ['Auto', 'Bassa', 'Media', 'Alta']

interface Spec {
  readonly id: string
  readonly caption: string
  readonly name: string
  readonly integration: string
  readonly role: ClimateRole
  readonly activity: ClimateActivity
  readonly since: string
  readonly current: number | null
  readonly target: number
  readonly flow?: number
  readonly humidity?: number
  readonly battery?: number
  readonly min?: number
  readonly max?: number
  readonly targetLabel?: string
  readonly mode?: ClimateChoice
  readonly fan?: string
  readonly swing?: boolean
  readonly preset?: ClimateChoice
  readonly heatCool?: ClimateChoice
}

const SPECS: readonly Spec[] = [
  {
    id: 'climate-ac-cool',
    caption: 'Raffresca · oscillazione',
    name: 'Clima soggiorno',
    integration: 'Gree',
    role: 'ac',
    activity: 'cool',
    since: 'da 40 min',
    current: 24.5,
    target: 22,
    humidity: 48,
    mode: choice('Freddo', MODES),
    fan: 'Auto',
    swing: true,
  },
  {
    id: 'climate-thermostat-heat',
    caption: 'Riscalda',
    name: 'Termostato',
    integration: 'Netatmo',
    role: 'thermostat',
    activity: 'heat',
    since: 'da 40 min',
    current: 19.5,
    target: 21,
    humidity: 55,
    mode: choice('Caldo', ['Caldo', 'Spento']),
    preset: choice('Comfort', ['Eco', 'Comfort', 'Boost']),
  },
  {
    id: 'climate-floor-heat',
    caption: 'Riscalda',
    name: 'Pavimento bagno',
    integration: 'Homematic',
    role: 'floor',
    activity: 'heat',
    since: 'da 40 min',
    current: 22,
    target: 24,
  },
  {
    id: 'climate-radiator-window',
    caption: 'Finestra aperta',
    name: 'Termosifone camera',
    integration: 'Homematic',
    role: 'radiator',
    activity: 'window',
    since: 'da 6 min',
    current: 18.5,
    target: 21,
    battery: 61,
  },
  {
    id: 'climate-heater-heat',
    caption: 'Riscalda',
    name: 'Stufetta studio',
    integration: 'Shelly',
    role: 'heater',
    activity: 'heat',
    since: 'da 40 min',
    current: 18,
    target: 20,
  },
  {
    id: 'climate-ac-infrared',
    caption: 'A infrarossi · stato non noto',
    name: 'Clima camera',
    integration: 'Infrarossi',
    role: 'ac',
    activity: 'unknown',
    since: 'Freddo',
    current: null,
    target: 24,
    mode: choice('Freddo', MODES),
    fan: 'Media',
    swing: false,
  },
  {
    id: 'climate-floor-idle',
    caption: 'In attesa',
    name: 'Pavimento cucina',
    integration: 'Homematic',
    role: 'floor',
    activity: 'idle',
    since: 'da 40 min',
    current: 22.5,
    target: 22.5,
  },
  {
    id: 'climate-circuit-heat',
    caption: 'Circuito della pompa di calore',
    name: 'Circuito 1',
    integration: 'Bosch HomeCom',
    role: 'hpcircuit',
    activity: 'heat',
    since: 'da 40 min',
    current: null,
    flow: 30,
    target: 21,
    min: 5,
    max: 30,
    targetLabel: 'comfort',
    mode: choice('Manuale', ['Spento', 'Manuale', 'Auto']),
    preset: choice('Comfort', ['Comfort', 'Eco']),
    heatCool: choice('Caldo', ['Caldo', 'Freddo', 'Auto']),
  },
  {
    id: 'climate-ac-off',
    caption: 'Spento',
    name: 'Clima studio',
    integration: 'Gree',
    role: 'ac',
    activity: 'off',
    since: 'da 3 h',
    current: 26,
    target: 23,
    humidity: 52,
    mode: choice('Freddo', MODES),
    fan: 'Auto',
    swing: false,
  },
]

function build(spec: Spec, orientation: CardOrientation): ClimateFixture {
  return {
    id: orientation === 'vertical' ? spec.id : `${spec.id}-horizontal`,
    caption: orientation === 'vertical' ? spec.caption : 'Orizzontale',
    orientation,
    model: {
      common: mockupCommon({
        name: spec.name,
        integration: spec.integration,
        watts: 0,
        supplyName: 'Interruttore clima',
        consumables: [
          {
            key: 'filter',
            label: 'Filtro aria',
            percent: 20,
            resetLabel: 'Pulito',
          },
        ],
        remote: [
          { id: 'power', label: 'Accendi / spegni', glyph: 'power' },
          { id: 'cool', label: 'Freddo', glyph: 'cool' },
          { id: 'heat', label: 'Caldo', glyph: 'heat' },
          { id: 'up', label: 'Su', glyph: 'plus' },
          { id: 'down', label: 'Giù', glyph: 'minus' },
          { id: 'fan', label: 'Ventola', glyph: 'fan' },
          { id: 'swing', label: 'Oscillazione', glyph: 'swing' },
        ],
        ...(spec.battery === undefined ? {} : { battery: spec.battery }),
      }),
      role: spec.role,
      on: spec.activity !== 'off',
      canPower: true,
      activity: spec.activity,
      since: spec.since,
      current: spec.current,
      flow: spec.flow ?? null,
      humidity: spec.humidity ?? null,
      target: {
        value: spec.target,
        min: spec.min ?? 16,
        max: spec.max ?? 30,
        step: spec.current === null && spec.flow === undefined ? 1 : 0.5,
        label: spec.targetLabel ?? null,
      },
      range: null,
      valve: null,
      mode: spec.mode ?? null,
      fan: spec.fan === undefined ? null : choice(spec.fan, FANS),
      swing: spec.swing ?? null,
      swingHorizontal: null,
      preset: spec.preset ?? null,
      heatCool: spec.heatCool ?? null,
    },
  }
}

export const CLIMATE_FIXTURES: readonly ClimateFixture[] = [
  ...SPECS.map((s) => build(s, 'vertical')),
  ...SPECS.slice(0, 1).map((s) => build(s, 'horizontal')),
]

const THERMOSTAT = CLIMATE_FIXTURES.find((f) => f.id === 'climate-thermostat-heat')

function extra(
  id: string,
  caption: string,
  orientation: CardOrientation,
  patch: Partial<ClimateCardModel>,
): ClimateFixture[] {
  if (THERMOSTAT === undefined) return []
  return [{ id, caption, orientation, model: { ...THERMOSTAT.model, ...patch } }]
}

/**
 * Variants real devices have and the mockup page does not draw: a held band
 * (two setpoints), a radiator valve next to its thermostat, a valve that only
 * reports, and a device whose reachability is not known.
 */
export const CLIMATE_EXTRA_FIXTURES: readonly ClimateFixture[] = [
  ...extra('climate-band', 'Banda caldo / freddo', 'vertical', {
    activity: 'idle',
    target: null,
    range: { low: 19, high: 24, min: 16, max: 30, step: 0.5, editable: true },
    preset: null,
    swing: false,
    swingHorizontal: true,
  }),
  ...extra('climate-band-horizontal', 'Banda, orizzontale', 'horizontal', {
    activity: 'idle',
    target: null,
    range: { low: 19, high: 24, min: 16, max: 30, step: 0.5, editable: true },
  }),
  ...extra('climate-valve', 'Termostato con valvola', 'vertical', {
    role: 'radiator',
    valve: { position: 65 },
  }),
  ...extra('climate-valve-only', 'Solo valvola', 'vertical', {
    role: 'radiator',
    canPower: false,
    current: null,
    humidity: null,
    target: null,
    mode: null,
    preset: null,
    valve: { position: 40 },
    common: {
      ...THERMOSTAT?.model.common,
      name: 'Valvola bagno',
      integration: 'Homematic',
      online: null,
      offlineLabel: null,
      readOnly: false,
      notice: null,
      power: null,
      battery: { level: 61 },
      supply: null,
      consumables: null,
      remote: null,
      history: null,
    },
  }),
]
