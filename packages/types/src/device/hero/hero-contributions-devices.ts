/**
 * What the household-device caps add to a hero (D1023): a fan, a robot vacuum,
 * a robot mower, a pet feeder, a pet fountain and its pump cycle. Typed against
 * each cap's own status schema; a slice that does not parse is "not answered"
 * (`unknown`, never `off`, D315/D393). A measurement the device did not report
 * is absent from the facts, never a zero (D393).
 */
import { FanControlStatusSchema } from '../../capabilities/fan-control.cap.js'
import {
  LawnMowerControlStatusSchema,
  type LawnMowerActivity,
} from '../../capabilities/lawn-mower-control.cap.js'
import {
  PET_FEEDER_MANUAL_FEED_MIN,
  PetFeederStatusSchema,
  type PetFeederStatus,
} from '../../capabilities/pet-feeder.cap.js'
import { PetFountainStatusSchema } from '../../capabilities/pet-fountain.cap.js'
import { PumpCycleStatusSchema } from '../../capabilities/pump-cycle.cap.js'
import {
  VacuumControlStatusSchema,
  type VacuumState,
} from '../../capabilities/vacuum-control.cap.js'
import { DeviceFeature } from '../device-type.js'
import type { VocabIcon } from './cap-vocabulary-icon.js'
import {
  action,
  asAction,
  contribution,
  fact,
  joinText,
  reading,
  row,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { HeroContext } from './hero-fragment.js'
import type { HeroArgs, HeroControl, HeroFact } from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'

const has = (ctx: HeroContext, f: DeviceFeature): boolean => ctx.features.includes(f)
const unknownText = heroText('Unknown', 'Sconosciuto')
const pct = (n: number): HeroText => heroText(`${Math.round(n)}%`, `${Math.round(n)}%`)
const unit = (n: number): number => Math.min(1, Math.max(0, n / 100))

interface StateWords {
  readonly state: HeroState
  readonly title: HeroText
}

/** Battery as a fact, unless the device is also bound to the `battery` cap (it already says so). */
function ownBattery(level: number | null, ctx: HeroContext): HeroFact[] {
  if (level === null || ctx.caps.includes('battery')) return []
  const tone = level <= 20 ? 'danger' : level <= 40 ? 'warning' : 'success'
  const text = heroText(`Battery ${Math.round(level)}%`, `Batteria ${Math.round(level)}%`)
  return [fact('battery', 'battery', text, tone)]
}

// ── fan-control ────────────────────────────────────────────────────────────

const fanContribution = contribution('fan-control', FanControlStatusSchema, (slice, ctx) => {
  const speed = slice?.speed ?? null
  const state: HeroState = speed === null ? 'unknown' : speed > 0 ? 'running' : 'off'
  const controls: HeroControl[] = []
  if (speed !== null || has(ctx, DeviceFeature.FanSpeed)) {
    controls.push({
      kind: 'slider',
      id: 'fan.speed',
      label: heroText('Speed', 'Velocità'),
      value: speed,
      min: 0,
      max: 100,
      step: slice?.percentageStep ?? 1,
      unit: '%',
      call: { cap: 'fan-control', method: 'setPercentage', args: {} },
      valueArg: 'speed',
    })
  }
  if (slice !== undefined && slice.availablePresets.length > 0) {
    controls.push({
      kind: 'picker',
      id: 'fan.preset',
      label: heroText('Mode', 'Modalità'),
      current: slice.preset === '' ? null : slice.preset,
      options: [...slice.availablePresets],
      call: { cap: 'fan-control', method: 'setPreset', args: {} },
      valueArg: 'preset',
    })
  }
  if (slice?.oscillating != null || has(ctx, DeviceFeature.FanOscillating)) {
    controls.push({
      kind: 'toggle',
      id: 'fan.oscillating',
      label: heroText('Oscillate', 'Oscilla'),
      on: slice?.oscillating ?? null,
      turnOn: action(
        'fan.oscillate.on',
        heroText('Oscillate', 'Oscilla'),
        'refresh-cw',
        'fan-control',
        'setOscillating',
        { oscillating: true },
      ),
      turnOff: action(
        'fan.oscillate.off',
        heroText('Hold still', 'Fermo'),
        'square',
        'fan-control',
        'setOscillating',
        { oscillating: false },
      ),
    })
  }
  if (slice?.direction != null || has(ctx, DeviceFeature.FanDirection)) {
    controls.push({
      kind: 'picker',
      id: 'fan.direction',
      label: heroText('Direction', 'Direzione'),
      current: slice?.direction ?? null,
      options: ['forward', 'reverse'],
      call: { cap: 'fan-control', method: 'setDirection', args: {} },
      valueArg: 'direction',
    })
  }
  const speedText = speed === null ? null : pct(speed)
  const preset = slice?.preset ?? ''
  const status =
    speed === null
      ? unknownText
      : joinText([
          speed === 0
            ? heroText('Off', 'Spento')
            : heroText(`Speed ${speed}%`, `Velocità ${speed}%`),
          preset === '' ? null : heroText(preset, preset),
        ])
  return {
    reading: reading('fan-control', state),
    rows: [{ id: 'fan', icon: 'fan', status, controls }],
    ...(speedText === null
      ? {}
      : {
          facts: [fact('speed', 'fan', speedText, speed === 0 ? 'muted' : 'primary')],
          tiles: {
            ...(slice?.oscillating == null
              ? {}
              : {
                  left: [
                    {
                      label: heroText('Oscillation', 'Oscilla'),
                      value: slice.oscillating ? heroText('Yes', 'Sì') : heroText('No', 'No'),
                    },
                  ],
                }),
            ...(preset === ''
              ? {}
              : {
                  right: [{ label: heroText('Mode', 'Modalità'), value: heroText(preset, preset) }],
                }),
          },
          scene: { level: unit(speed ?? 0) },
        }),
  }
})

// ── vacuum-control ─────────────────────────────────────────────────────────

const VACUUM_WORDS: Readonly<Record<VacuumState, StateWords>> = {
  idle: { state: 'idle', title: heroText('Idle', 'Inattivo') },
  cleaning: { state: 'running', title: heroText('Cleaning', 'Pulisce') },
  paused: { state: 'standby', title: heroText('Paused', 'In pausa') },
  returning: { state: 'running', title: heroText('Returning to base', 'Torna alla base') },
  docked: { state: 'idle', title: heroText('Docked', 'In base') },
  drying: { state: 'running', title: heroText('Drying', 'Asciuga') },
  error: { state: 'alert', title: heroText('Error', 'Errore') },
}

function robotAction(
  cap: string,
  prefix: string,
  id: string,
  en: string,
  it: string,
  icon: VocabIcon,
  method: string,
  primary = false,
): HeroControl {
  return asAction(
    action(
      `${prefix}.${id}`,
      heroText(en, it),
      icon,
      cap,
      method,
      {},
      primary ? 'primary' : 'normal',
    ),
  )
}

const vac = (
  id: string,
  en: string,
  it: string,
  icon: VocabIcon,
  method: string,
  primary = false,
): HeroControl => robotAction('vacuum-control', 'vacuum', id, en, it, icon, method, primary)

function vacuumControls(state: VacuumState | null): HeroControl[] {
  const start = (primary: boolean) => vac('start', 'Start', 'Avvia', 'play', 'start', primary)
  const resume = vac('resume', 'Resume', 'Riprendi', 'play', 'start', true)
  const pause = (primary: boolean) => vac('pause', 'Pause', 'Pausa', 'pause', 'pause', primary)
  const base = vac('base', 'Return to base', 'Torna alla base', 'house', 'returnToBase')
  switch (state) {
    case 'cleaning':
      return [pause(true), base]
    case 'paused':
      return [resume, base]
    case 'returning':
    case 'drying':
      return [vac('stop', 'Stop', 'Ferma', 'square', 'stop')]
    case 'idle':
      return [start(true), base]
    case 'docked':
      return [start(true)]
    case 'error':
      return [base]
    case null:
      // Nothing is known: every declared action is offered, none is guessed.
      return [start(false), pause(false), base]
  }
}

const vacuumContribution = contribution(
  'vacuum-control',
  VacuumControlStatusSchema,
  (slice, ctx) => {
    const state = slice?.state ?? null
    const words = state === null ? null : VACUUM_WORDS[state]
    const title =
      state === 'error' && slice?.errorLabel
        ? heroText(slice.errorLabel, slice.errorLabel)
        : words?.title
    const controls = vacuumControls(state)
    if (slice !== undefined && slice.availableFanSpeeds.length > 0) {
      controls.push({
        kind: 'picker',
        id: 'vacuum.suction',
        label: heroText('Suction', 'Aspirazione'),
        current: slice.fanSpeed,
        options: [...slice.availableFanSpeeds],
        call: { cap: 'vacuum-control', method: 'setFanSpeed', args: {} },
        valueArg: 'speed',
      })
    }
    if (state !== null) controls.push(vac('locate', 'Locate', 'Trova', 'map-pin', 'locate'))
    const progress = state === 'cleaning' ? (slice?.progress ?? null) : null
    return {
      reading: reading('vacuum-control', words?.state ?? 'unknown', false, title),
      rows: [{ id: 'vacuum', icon: 'bot', status: title ?? unknownText, controls }],
      facts: [
        ...ownBattery(slice?.batteryLevel ?? null, ctx),
        ...(progress === null ? [] : [fact('progress', 'activity', pct(progress), 'primary')]),
      ],
      ...(progress === null
        ? {}
        : {
            tiles: {
              right: [{ label: heroText('Progress', 'Avanzamento'), value: pct(progress) }],
            },
            scene: { level: unit(progress) },
          }),
    }
  },
)

// ── lawn-mower-control ─────────────────────────────────────────────────────

const MOWER_WORDS: Readonly<Record<LawnMowerActivity, StateWords>> = {
  idle: { state: 'idle', title: heroText('Idle', 'Inattivo') },
  mowing: { state: 'running', title: heroText('Mowing', 'Taglia') },
  paused: { state: 'standby', title: heroText('Paused', 'In pausa') },
  docked: { state: 'idle', title: heroText('Docked', 'In base') },
  error: { state: 'alert', title: heroText('Error', 'Errore') },
}

const mow = (
  id: string,
  en: string,
  it: string,
  icon: VocabIcon,
  method: string,
  primary = false,
): HeroControl => robotAction('lawn-mower-control', 'mower', id, en, it, icon, method, primary)

function mowerControls(activity: LawnMowerActivity | null): HeroControl[] {
  const start = (primary: boolean) =>
    mow('start', 'Start mowing', 'Avvia il taglio', 'play', 'startMowing', primary)
  const pause = (primary: boolean) => mow('pause', 'Pause', 'Pausa', 'pause', 'pause', primary)
  const dock = mow('dock', 'Return to base', 'Torna alla base', 'house', 'dock')
  switch (activity) {
    case 'mowing':
      return [pause(true), dock]
    case 'paused':
      return [mow('resume', 'Resume', 'Riprendi', 'play', 'startMowing', true), dock]
    case 'idle':
      return [start(true), dock]
    case 'docked':
      return [start(true)]
    case 'error':
      return [dock]
    case null:
      return [start(false), pause(false), dock]
  }
}

const mowerContribution = contribution(
  'lawn-mower-control',
  LawnMowerControlStatusSchema,
  (slice, ctx) => {
    const activity = slice?.activity ?? null
    const words = activity === null ? null : MOWER_WORDS[activity]
    const title =
      activity === 'error' && slice?.currentCodeLabel
        ? heroText(slice.currentCodeLabel, slice.currentCodeLabel)
        : words?.title
    const progress = activity === 'mowing' ? (slice?.progress ?? null) : null
    return {
      reading: reading('lawn-mower-control', words?.state ?? 'unknown', false, title),
      rows: [
        {
          id: 'mower',
          icon: 'sprout',
          status: title ?? unknownText,
          controls: mowerControls(activity),
        },
      ],
      facts: [
        ...ownBattery(slice?.batteryLevel ?? null, ctx),
        ...(progress === null ? [] : [fact('progress', 'activity', pct(progress), 'primary')]),
      ],
      ...(progress === null
        ? {}
        : {
            tiles: {
              right: [{ label: heroText('Progress', 'Avanzamento'), value: pct(progress) }],
            },
            scene: { level: unit(progress) },
          }),
    }
  },
)

// ── pet-feeder ─────────────────────────────────────────────────────────────

function feederWords(slice: PetFeederStatus | undefined): StateWords | null {
  if (slice === undefined) return null
  if (slice.status === 'offline') {
    return { state: 'offline', title: heroText('Offline', 'Non raggiungibile') }
  }
  if (slice.error !== null) return { state: 'alert', title: heroText(slice.error, slice.error) }
  if (slice.feeding) return { state: 'running', title: heroText('Dispensing', 'Eroga') }
  if (slice.eating) return { state: 'running', title: heroText('Pet is eating', 'Sta mangiando') }
  if (slice.lowFood) {
    return { state: 'standby', title: heroText('Food is low', 'Cibo in esaurimento') }
  }
  return { state: 'idle', title: heroText('Ready', 'Pronto') }
}

/** The manual portion the card offers: the last one given, else the hardware minimum. */
function feedArgs(slice: PetFeederStatus): HeroArgs {
  if (slice.isDualHopper) {
    return {
      hopper1: slice.lastFeedHopper1 ?? PET_FEEDER_MANUAL_FEED_MIN,
      hopper2: slice.lastFeedHopper2 ?? PET_FEEDER_MANUAL_FEED_MIN,
    }
  }
  return { grams: slice.lastFeedGrams ?? PET_FEEDER_MANUAL_FEED_MIN }
}

function feederControls(slice: PetFeederStatus): HeroControl[] {
  const primary = slice.feeding
    ? action(
        'feeder.cancel',
        heroText('Cancel', 'Annulla'),
        'square',
        'pet-feeder',
        'cancelFeed',
        {},
        'primary',
      )
    : action(
        'feeder.feed',
        slice.isDualHopper
          ? heroText('Feed', 'Eroga')
          : heroText(
              `Feed ${slice.lastFeedGrams ?? PET_FEEDER_MANUAL_FEED_MIN} g`,
              `Eroga ${slice.lastFeedGrams ?? PET_FEEDER_MANUAL_FEED_MIN} g`,
            ),
        'bone',
        'pet-feeder',
        'feed',
        feedArgs(slice),
        'primary',
      )
  return [
    asAction(primary),
    asAction(
      action('feeder.call', heroText('Call pet', 'Chiama'), 'volume-2', 'pet-feeder', 'callPet'),
    ),
    {
      kind: 'toggle',
      id: 'feeder.child-lock',
      label: heroText('Child lock', 'Blocco bambini'),
      on: slice.childLock,
      turnOn: action(
        'feeder.child-lock.on',
        heroText('Lock', 'Blocca'),
        'lock',
        'pet-feeder',
        'setChildLock',
        { on: true },
      ),
      turnOff: action(
        'feeder.child-lock.off',
        heroText('Unlock', 'Sblocca'),
        'lock-open',
        'pet-feeder',
        'setChildLock',
        { on: false },
      ),
    },
  ]
}

const feederContribution = contribution('pet-feeder', PetFeederStatusSchema, (slice, ctx) => {
  const words = feederWords(slice)
  const last = slice?.lastFeedGrams ?? null
  return {
    reading: reading('pet-feeder', words?.state ?? 'unknown', false, words?.title),
    rows: [
      {
        id: 'feeder',
        icon: 'bone',
        status: words?.title ?? unknownText,
        controls: slice === undefined ? [] : feederControls(slice),
      },
    ],
    facts: [
      ...(slice?.lowFood === true
        ? [fact('level', 'bone', heroText('Food low', 'Cibo in esaurimento'), 'warning')]
        : []),
      ...(last === null
        ? []
        : [fact('last-run', 'clock', heroText(`Last ${last} g`, `Ultimo ${last} g`))]),
      ...ownBattery(slice?.powerSource === 'battery' ? slice.batteryPower : null, ctx),
    ],
    tiles: {
      left: [
        ...(slice?.foodLevel == null
          ? []
          : [{ label: heroText('Tank', 'Serbatoio'), value: pct(slice.foodLevel) }]),
        ...(last === null
          ? []
          : [
              {
                label: heroText('Last portion', 'Ultima porzione'),
                value: heroText(`${last} g`, `${last} g`),
              },
            ]),
      ],
    },
  }
})

// ── pet-fountain ───────────────────────────────────────────────────────────

const fountainContribution = contribution('pet-fountain', PetFountainStatusSchema, (slice) => {
  const pump = slice?.pumpRunning ?? null
  const fault = slice?.error ?? null
  const empty = slice?.empty === true
  const state: HeroState =
    slice === undefined
      ? 'unknown'
      : fault !== null || empty
        ? 'alert'
        : pump === null
          ? 'unknown'
          : pump
            ? 'running'
            : 'off'
  const title =
    slice === undefined
      ? undefined
      : fault !== null
        ? heroText(fault, fault)
        : empty
          ? heroText('Tank empty', 'Serbatoio vuoto')
          : pump === null
            ? undefined
            : pump
              ? heroText('Pump running', 'Pompa attiva')
              : heroText('Pump off', 'Pompa spenta')
  const level = slice?.waterLevel ?? null
  const control: HeroControl = {
    kind: 'toggle',
    id: 'fountain.pump',
    label: heroText('Pump', 'Pompa'),
    on: pump,
    turnOn: action(
      'fountain.pump.on',
      heroText('Pump on', 'Accendi la pompa'),
      'droplets',
      'pet-fountain',
      'setPump',
      { on: true },
      'primary',
    ),
    turnOff: action(
      'fountain.pump.off',
      heroText('Pump off', 'Spegni la pompa'),
      'square',
      'pet-fountain',
      'setPump',
      { on: false },
    ),
  }
  return {
    reading: reading('pet-fountain', state, false, title),
    rows: [
      {
        id: 'fountain',
        icon: 'droplets',
        status: title ?? unknownText,
        controls: slice === undefined ? [] : [control],
      },
    ],
    ...(level === null
      ? {}
      : {
          facts: [
            fact(
              'level',
              'droplets',
              heroText(`Water ${Math.round(level)}%`, `Acqua ${Math.round(level)}%`),
              level <= 20 ? 'warning' : 'primary',
            ),
          ],
          tiles: {
            left: [
              { label: heroText('Water', 'Acqua'), value: pct(level) },
              ...(slice?.waterVolume == null
                ? []
                : [
                    {
                      label: heroText('Volume', 'Volume'),
                      value: heroText(
                        `${Math.round(slice.waterVolume)} ml`,
                        `${Math.round(slice.waterVolume)} ml`,
                      ),
                    },
                  ]),
            ],
          },
          scene: { level: unit(level) },
        }),
  }
})

// ── pump-cycle ─────────────────────────────────────────────────────────────

const minutesOf = (seconds: number): number => Math.max(0, Math.round(seconds / 60))

const pumpCycleContribution = contribution('pump-cycle', PumpCycleStatusSchema, (slice) => {
  const enabled = slice?.enabled ?? null
  const cycle =
    slice?.onTime != null && slice.offTime != null
      ? heroText(
          `${minutesOf(slice.onTime)} min on · ${minutesOf(slice.offTime)} min off`,
          `${minutesOf(slice.onTime)} min acceso · ${minutesOf(slice.offTime)} min spento`,
        )
      : null
  const status =
    enabled === null
      ? unknownText
      : enabled
        ? joinText([heroText('Cycling', 'A cicli'), cycle])
        : heroText('Runs continuously', 'Sempre attiva')
  return {
    rows: [
      row('pump-cycle', 'timer', status, [
        {
          kind: 'toggle',
          id: 'pump-cycle.enabled',
          label: heroText('Pump cycle', 'Ciclo pompa'),
          on: enabled,
          turnOn: action(
            'pump-cycle.on',
            heroText('Cycle the pump', 'Attiva il ciclo'),
            'timer',
            'pump-cycle',
            'setEnabled',
            { on: true },
          ),
          turnOff: action(
            'pump-cycle.off',
            heroText('Run continuously', 'Sempre attiva'),
            'timer-off',
            'pump-cycle',
            'setEnabled',
            { on: false },
          ),
        },
      ]),
    ],
  }
})

export const DEVICES_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  'fan-control': fanContribution,
  'vacuum-control': vacuumContribution,
  'lawn-mower-control': mowerContribution,
  'pet-feeder': feederContribution,
  'pet-fountain': fountainContribution,
  'pump-cycle': pumpCycleContribution,
}
