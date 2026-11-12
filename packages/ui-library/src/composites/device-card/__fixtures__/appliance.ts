/**
 * The washer, dryer and dishwasher pages of the approved mockup: first the
 * appliance built on a smart plug (running from the draw, finished, plug off),
 * then the connected machine (stopped, running, paused, and horizontal).
 */
import type { ApplianceKind } from '../illustrations/ApplianceIllustration'
import type {
  ApplianceCardModel,
  AppliancePhase,
  ApplianceProgram,
} from '../scenes/appliance/model'
import type { CardConsumable, CardOrientation, CardRemoteKey } from '../shell/model'
import { mockupCommon } from './common'

export interface ApplianceFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: ApplianceCardModel
}

interface KindData {
  readonly name: string
  readonly watts: number
  readonly supply: string
  readonly runWord: string | null
  readonly programs: readonly ApplianceProgram[]
  readonly consumables: readonly CardConsumable[]
  readonly remote: readonly CardRemoteKey[]
}

const prog = (id: string, minutes: number): ApplianceProgram => ({ id, label: id, minutes })
const item = (key: string, percent: number, resetLabel: string, note?: string): CardConsumable => ({
  key,
  label: key,
  percent,
  resetLabel,
  ...(note === undefined ? {} : { note }),
})

const KINDS: Readonly<Record<ApplianceKind, KindData>> = {
  washer: {
    name: 'Lavatrice',
    watts: 1950,
    supply: 'Presa lavanderia',
    runWord: null,
    programs: [
      prog('Cotone 40°', 155),
      prog('Sintetici 30°', 95),
      prog('Eco 40-60', 210),
      prog('Rapido 15′', 15),
      prog('Lana 30°', 40),
    ],
    consumables: [
      item('Detersivo', 30, 'Riempito'),
      item('Ammorbidente', 75, 'Riempito'),
      item('Pulizia cestello', 12, 'Fatta', 'tra 3 cicli'),
    ],
    remote: [
      { id: 'power', label: 'Accendi', glyph: 'power' },
      { id: 'play', label: 'Avvio', glyph: 'play' },
      { id: 'pause', label: 'Pausa', glyph: 'pause' },
    ],
  },
  dryer: {
    name: 'Asciugatrice',
    watts: 780,
    supply: 'Presa lavanderia',
    runWord: null,
    programs: [
      prog('Cotone armadio', 150),
      prog('Sintetici', 80),
      prog('Delicati', 60),
      prog('Lana', 45),
      prog('Aria 30′', 30),
    ],
    consumables: [
      item('Vaschetta condensa', 15, 'Svuotata', 'quasi piena'),
      item('Filtro lanugine', 60, 'Pulito'),
    ],
    remote: [
      { id: 'power', label: 'Accendi', glyph: 'power' },
      { id: 'play', label: 'Avvio', glyph: 'play' },
      { id: 'pause', label: 'Pausa', glyph: 'pause' },
    ],
  },
  dish: {
    name: 'Lavastoviglie',
    watts: 2100,
    supply: 'Presa cucina',
    runWord: 'Risciacquo',
    programs: [
      prog('Eco 50°', 225),
      prog('Auto 45-65°', 150),
      prog('Intensivo 70°', 140),
      prog('Rapido 45°', 29),
      prog('Prelavaggio', 15),
    ],
    consumables: [item('Brillantante', 70, 'Riempito'), item('Sale rigenerante', 25, 'Riempito')],
    remote: [
      { id: 'power', label: 'Accendi', glyph: 'power' },
      { id: 'play', label: 'Avvio', glyph: 'play' },
      { id: 'pause', label: 'Pausa', glyph: 'pause' },
    ],
  },
}

type PlugPhase = 'run' | 'done' | 'off'

const PLUG_WATTS: Readonly<Record<PlugPhase, (k: KindData) => number>> = {
  run: (k) => k.watts,
  done: () => 1,
  off: () => 0,
}
const PLUG_SINCE: Readonly<Record<PlugPhase, string>> = {
  run: '42 min',
  done: 'da 12 min',
  off: 'da 3 h',
}
const PLUG_CAPTION: Readonly<Record<PlugPhase, string>> = {
  run: 'In funzione (dal consumo)',
  done: 'Finita',
  off: 'Presa spenta',
}

function plugFixture(kind: ApplianceKind, phase: PlugPhase): ApplianceFixture {
  const k = KINDS[kind]
  return {
    id: `${kind}-plug-${phase}`,
    caption: PLUG_CAPTION[phase],
    orientation: 'vertical',
    model: {
      common: {
        ...mockupCommon({
          name: k.name,
          integration: 'Shelly · ruolo personalizzato',
          watts: PLUG_WATTS[phase](k),
          supplyName: '',
          consumables: [],
          remote: [],
        }),
        battery: null,
        supply: null,
        consumables: null,
        remote: null,
      },
      kind,
      phase,
      phaseLabel: null,
      since: PLUG_SINCE[phase],
      power: { on: phase !== 'off' },
      program: null,
      controls: null,
      remainingMinutes: null,
      endsAt: null,
      progress: null,
      startBlocked: null,
      errorLabel: null,
    },
  }
}

type CyclePhase = Extract<AppliancePhase, 'idle' | 'run' | 'pause'>

const CYCLE_WATTS: Readonly<Record<CyclePhase, (k: KindData) => number>> = {
  idle: () => 0,
  run: (k) => k.watts,
  pause: () => 4,
}
const CYCLE_SINCE: Readonly<Record<CyclePhase, string>> = {
  idle: 'da 3 h',
  run: '42 min',
  pause: 'da 4 min',
}
const CYCLE_CAPTION: Readonly<Record<CyclePhase, string>> = {
  idle: 'Ferma',
  run: 'In funzione',
  pause: 'In pausa',
}
const LEFT_MINUTES = 38

function cycleFixture(
  kind: ApplianceKind,
  phase: CyclePhase,
  orientation: CardOrientation = 'vertical',
): ApplianceFixture {
  const k = KINDS[kind]
  const first = k.programs[0]
  const total = first?.minutes ?? LEFT_MINUTES
  return {
    id: `${kind}-${phase}${orientation === 'horizontal' ? '-h' : ''}`,
    caption: orientation === 'horizontal' ? 'Orizzontale' : CYCLE_CAPTION[phase],
    orientation,
    model: {
      common: {
        ...mockupCommon({
          name: k.name,
          integration: 'Home Connect',
          watts: CYCLE_WATTS[phase](k),
          supplyName: k.supply,
          consumables: k.consumables,
          remote: k.remote,
        }),
        battery: null,
      },
      kind,
      phase,
      phaseLabel: phase === 'run' ? k.runWord : null,
      since: CYCLE_SINCE[phase],
      power: null,
      program: { options: k.programs, selected: first?.id ?? null, selectable: true },
      controls: { start: true, pause: true, resume: true, stop: true },
      remainingMinutes: phase === 'idle' ? null : LEFT_MINUTES,
      endsAt: phase === 'run' ? '11:58' : null,
      progress: phase === 'idle' ? null : Math.round(((total - LEFT_MINUTES) / total) * 100),
      startBlocked: null,
      errorLabel: null,
    },
  }
}

/** One mockup page: the plug-built variants, then the connected machine. */
export function applianceFixtures(kind: ApplianceKind): readonly ApplianceFixture[] {
  return [
    plugFixture(kind, 'run'),
    plugFixture(kind, 'done'),
    plugFixture(kind, 'off'),
    cycleFixture(kind, 'idle'),
    cycleFixture(kind, 'run'),
    cycleFixture(kind, 'pause'),
    cycleFixture(kind, 'run', 'horizontal'),
  ]
}

/** The mockup's "remote start off" and "door open" options, on a stopped machine. */
export function withStartBlocked(fixture: ApplianceFixture, reason: string): ApplianceFixture {
  return { ...fixture, model: { ...fixture.model, startBlocked: reason } }
}
