/**
 * What each capability contributes to a hero (D1023). The map is typed against
 * the cap's own status schema: a slice is parsed at the boundary, and one that
 * does not parse reads as "not answered", never as a value.
 *
 * Capabilities contribute, device types never do (D14): nothing here looks at a
 * vendor. A type only chooses which ROWS its layout carries and how it looks.
 * `HERO_CAP_COVERAGE` (the second file of this directory) says, for every
 * device cap, whether it contributes and why it does not; the guard
 * `scripts/check-cap-hero-contributions.ts` keeps it complete.
 */
import { BatteryStatusSchema } from '../../capabilities/battery.cap.js'
import { ConsumablesStatusSchema } from '../../capabilities/consumables.cap.js'
import { ContactStatusSchema } from '../../capabilities/contact.cap.js'
import { DishwasherStatusSchema, type DishwasherStatus } from '../../capabilities/dishwasher.cap.js'
import { MediaPlayerStatusSchema } from '../../capabilities/media-player.cap.js'
import { MotionTriggerStatusSchema } from '../../capabilities/motion-trigger.cap.js'
import { NetworkLinkStatusSchema } from '../../capabilities/network-link.cap.js'
import { PowerMeterStatusSchema } from '../../capabilities/power-meter.cap.js'
import { PowerSourceStateSchema } from '../../capabilities/power-source.cap.js'
import { RunningStateStatusSchema } from '../../capabilities/running-state.cap.js'
import { SwitchStatusSchema } from '../../capabilities/switch.cap.js'
import {
  TIMED_RUN_LIMITS,
  TimedRunStatusSchema,
  timedRunQuickRun,
} from '../../capabilities/timed-run.cap.js'
import { DeviceFeature, DeviceType } from '../device-type.js'
import type { VocabIcon } from './cap-vocabulary-icon.js'
import {
  action,
  asAction,
  contribution,
  elapsedText,
  fact,
  reading,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { HeroContext, StateReading } from './hero-fragment.js'
import type {
  HeroArgs,
  HeroBadge,
  HeroControl,
  HeroDetail,
  HeroFact,
  HeroRow,
  HeroSideTile,
} from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'
import { ACCESS_FAMILY_CONTRIBUTIONS } from './hero-contributions-access.js'
import { DEVICES_FAMILY_CONTRIBUTIONS } from './hero-contributions-devices.js'
import { ACTUATORS_FAMILY_CONTRIBUTIONS } from './hero-contributions-actuators.js'
import { GROUPS_FAMILY_CONTRIBUTIONS } from './hero-contributions-groups.js'
import { SENSORS_FAMILY_CONTRIBUTIONS } from './hero-contributions-sensors.js'
import { CLIMATE_FAMILY_CONTRIBUTIONS } from './hero-contributions-climate.js'
import {
  deriveMediaPlayerView,
  projectedPositionMs,
  type MediaPlayerView,
} from './media-player-view.js'

function minutesLeft(seconds: number): HeroText {
  const m = Math.ceil(seconds / 60)
  return heroText(`${m} min left`, `${m} min rimanenti`)
}

function deviceTypeOf(type: string): DeviceType | undefined {
  return Object.values(DeviceType).find((t) => t === type)
}

// ── switch ─────────────────────────────────────────────────────────────────

const switchContribution = contribution('switch', SwitchStatusSchema, (slice) => {
  const on = slice?.on ?? null
  return {
    reading: reading('switch', on === null ? 'unknown' : on ? 'on' : 'off'),
    ownPower: {
      source: 'switch',
      on,
      assumed: false,
      turnOn: action(
        'own-power.on',
        heroText('Turn on', 'Accendi'),
        'power',
        'switch',
        'setState',
        {
          on: true,
        },
      ),
      turnOff: action(
        'own-power.off',
        heroText('Turn off', 'Spegni'),
        'power-off',
        'switch',
        'setState',
        { on: false },
      ),
    },
  }
})

// ── running-state ──────────────────────────────────────────────────────────

const runningStateContribution = contribution(
  'running-state',
  RunningStateStatusSchema,
  (slice, ctx) => {
    const running = slice?.running ?? null
    const phase = slice?.phase ?? null
    const detail: HeroDetail[] = []
    if (slice?.since != null) {
      detail.push({
        label: heroText('Since', 'Da'),
        value: slice.since,
        unit: 'ms-epoch',
      })
    }
    if (phase !== null)
      detail.push({
        label: heroText('Phase', 'Fase'),
        value: phase,
        unit: null,
      })
    return {
      reading: reading(
        'running-state',
        running === null ? 'unknown' : running ? 'running' : 'idle',
      ),
      consumption: {
        priority: 1,
        slot: {
          kind: 'running',
          running,
          since: slice?.since ?? null,
          phase,
          detail,
        },
      },
      ...(phase !== null && running === true
        ? { facts: [fact('phase', 'activity', heroText(phase, phase), 'primary')] }
        : {}),
      ...(running === true && (phase !== null || slice?.since != null)
        ? {
            tiles: {
              ...(phase === null
                ? {}
                : { left: [{ label: heroText('Phase', 'Fase'), value: heroText(phase, phase) }] }),
              ...(slice?.since == null || elapsedText(slice.since, ctx.now) === null
                ? {}
                : {
                    right: [
                      {
                        label: heroText('Started', 'Avviata'),
                        value: elapsedText(slice.since, ctx.now) ?? heroText('', ''),
                      },
                    ],
                  }),
            },
          }
        : {}),
    }
  },
)

// ── power-meter ────────────────────────────────────────────────────────────

const powerMeterContribution = contribution('power-meter', PowerMeterStatusSchema, (slice) => {
  if (slice?.power === undefined) return {}
  const detail: HeroDetail[] = []
  if (slice.energy !== undefined) {
    detail.push({
      label: heroText('Energy', 'Energia'),
      value: slice.energy,
      unit: 'kWh',
    })
  }
  if (slice.voltage !== undefined) {
    detail.push({
      label: heroText('Voltage', 'Tensione'),
      value: slice.voltage,
      unit: 'V',
    })
  }
  if (slice.current !== undefined) {
    detail.push({
      label: heroText('Current', 'Corrente'),
      value: slice.current,
      unit: 'A',
    })
  }
  const watts = Math.round(slice.power)
  const text = heroText(`${watts} W`, `${watts} W`)
  return {
    consumption: {
      priority: 2,
      slot: { kind: 'power', watts: slice.power, detail },
    },
    facts: [fact('power', 'zap', text, watts > 0 ? 'primary' : 'muted')],
    tilesFallback: true,
    tiles: {
      right: [{ label: heroText('Power', 'Potenza'), value: text }],
      ...(slice.energy === undefined
        ? {}
        : {
            left: [
              {
                label: heroText('Energy', 'Energia'),
                value: heroText(`${slice.energy} kWh`, `${slice.energy} kWh`),
              },
            ],
          }),
    },
  }
})

// ── battery / network-link ─────────────────────────────────────────────────

function batteryTone(level: number | null): HeroBadge['tone'] {
  if (level === null) return 'muted'
  if (level <= 20) return 'danger'
  return level <= 40 ? 'warning' : 'success'
}

const batteryContribution = contribution('battery', BatteryStatusSchema, (slice) => {
  const level = slice?.level ?? null
  const badge: HeroBadge = {
    id: 'battery',
    icon: 'battery',
    tone: batteryTone(level),
    value: level,
    label:
      level === null
        ? heroText('Battery', 'Batteria')
        : heroText(`Battery ${level}%`, `Batteria ${level}%`),
  }
  return {
    badges: [badge],
    ...(level === null
      ? {}
      : {
          facts: [fact('battery', 'battery', badge.label, badge.tone)],
          tilesFallback: true,
          tiles: {
            left: [
              {
                label: heroText('Battery', 'Batteria'),
                value: heroText(`${level}%`, `${level}%`),
                tone: badge.tone,
              },
            ],
          },
        }),
  }
})

const networkLinkContribution = contribution('network-link', NetworkLinkStatusSchema, (slice) => {
  const signal = slice?.signal ?? null
  const known = slice !== undefined && slice.type !== 'unknown'
  const badge: HeroBadge = {
    id: 'network-link',
    icon: 'wifi',
    tone: !known ? 'muted' : signal !== null && signal < 30 ? 'warning' : 'success',
    value: signal,
    label: known
      ? heroText(slice.type, slice.type)
      : heroText('Link unknown', 'Collegamento sconosciuto'),
  }
  return {
    badges: [badge],
    ...(known ? { facts: [fact('link', 'wifi', badge.label, badge.tone)] } : {}),
  }
})

// ── contact / motion-trigger ───────────────────────────────────────────────

const contactContribution = contribution('contact', ContactStatusSchema, (slice) => {
  const row: HeroRow = {
    id: 'contact',
    icon: slice?.entryOpen === true ? 'door-open' : 'door-closed',
    status:
      slice === undefined
        ? heroText('Unknown', 'Sconosciuto')
        : slice.entryOpen
          ? heroText('Open', 'Aperto')
          : heroText('Closed', 'Chiuso'),
    controls: [],
  }
  return {
    reading: reading('contact', slice === undefined ? 'unknown' : slice.entryOpen ? 'on' : 'off'),
    rows: [row],
    ...(slice === undefined ? {} : { scene: { mode: slice.entryOpen ? 'open' : 'closed' } }),
  }
})

const motionTriggerContribution = contribution(
  'motion-trigger',
  MotionTriggerStatusSchema,
  (slice) => {
    const on = slice?.enabled ?? null
    const toggle: HeroControl = {
      kind: 'toggle',
      id: 'motion-trigger.toggle',
      label: heroText('Follow motion', 'Segui il movimento'),
      on,
      turnOn: action(
        'motion-trigger.on',
        heroText('Enable', 'Attiva'),
        'activity',
        'motion-trigger',
        'setMotionTrigger',
        { enabled: true },
      ),
      turnOff: action(
        'motion-trigger.off',
        heroText('Disable', 'Disattiva'),
        'activity',
        'motion-trigger',
        'setMotionTrigger',
        { enabled: false },
      ),
    }
    return {
      rows: [
        {
          id: 'motion-trigger',
          icon: 'activity',
          status:
            on === null
              ? heroText('Unknown', 'Sconosciuto')
              : on
                ? heroText('Follows motion', 'Segue il movimento')
                : heroText('Ignores motion', 'Ignora il movimento'),
          controls: [toggle],
        },
      ],
    }
  },
)

// ── timed-run ──────────────────────────────────────────────────────────────

/** The armed run's length: "Timer 25 min". */
function timerTile(quickRun: { readonly duration: number; readonly unit: string }): HeroSideTile {
  const text = `${quickRun.duration} ${quickRun.unit}`
  return { label: heroText('Timer', 'Timer'), value: heroText(text, text) }
}

const timedRunContribution = contribution('timed-run', TimedRunStatusSchema, (slice, ctx) => {
  const type = deviceTypeOf(ctx.type)
  const limit = type === undefined ? undefined : TIMED_RUN_LIMITS[type]
  // Offered only to the types that have a limit.
  if (limit === undefined) return {}
  const quickRun = slice?.quickRun ?? timedRunQuickRun(limit, null)
  const activeUntil =
    slice?.activeUntil != null && slice.activeUntil > ctx.now ? slice.activeUntil : null
  const runArgs: HeroArgs = {
    duration: quickRun.duration,
    unit: quickRun.unit,
  }
  const label = heroText(
    `Run ${quickRun.duration} ${quickRun.unit}`,
    `Avvia ${quickRun.duration} ${quickRun.unit}`,
  )
  const run = action('timed-run.run', label, 'timer', 'timed-run', 'runFor', runArgs, 'primary')
  const cancel = action(
    'timed-run.cancel',
    heroText('Stop', 'Ferma'),
    'timer-off',
    'timed-run',
    'cancel',
  )
  const restart = action(
    'timed-run.restart',
    heroText('Restart', 'Riavvia'),
    'rotate-cw',
    'timed-run',
    'runFor',
    runArgs,
  )
  const left = activeUntil === null ? 0 : Math.max(1, Math.ceil((activeUntil - ctx.now) / 60_000))
  const row: HeroRow = {
    id: 'run-for',
    icon: 'timer',
    status:
      activeUntil === null
        ? heroText(
            `Run for ${quickRun.duration} ${quickRun.unit}`,
            `Avvia per ${quickRun.duration} ${quickRun.unit}`,
          )
        : heroText(`Stops in ${left} min`, `Si ferma tra ${left} min`),
    controls: activeUntil === null ? [asAction(run)] : [asAction(cancel), asAction(restart)],
  }
  const armed = activeUntil === null ? {} : { right: [timerTile(quickRun)] }
  return {
    timedRun: { activeUntil, quickRun, run, cancel },
    rows: [row],
    tilesFallback: true,
    tiles: armed,
  }
})

// ── power-source ───────────────────────────────────────────────────────────

const powerSourceContribution = contribution(
  'power-source',
  PowerSourceStateSchema,
  (slice, ctx) => ({
    powerSupply: {
      on: slice?.switchOn ?? null,
      confirmOffWhileRunning: ctx.running === true,
      running: ctx.running ?? null,
      powerOn: action(
        'power-supply.on',
        heroText('Power on', 'Alimenta'),
        'plug',
        'power-source',
        'powerOn',
      ),
      powerOff: action(
        'power-supply.off',
        heroText('Power off', 'Togli alimentazione'),
        'plug-zap',
        'power-source',
        'powerOff',
        {},
        'normal',
        'off-while-running',
      ),
      restart: action(
        'power-supply.restart',
        heroText('Restart', 'Riavvia'),
        'rotate-cw',
        'power-source',
        'forceRestart',
      ),
    },
  }),
)

// ── remote / consumables ───────────────────────────────────────────────────

/** The remote cap has no status: the model's input carries how many commands it holds. */
const remoteContribution: HeroContribution = {
  cap: 'remote',
  contribute: (_slice, ctx) =>
    ctx.remoteCommands === 0 ? {} : { remote: { commands: ctx.remoteCommands } },
}

const ATTENTION_STATUSES: readonly string[] = ['low', 'empty', 'replace']

const consumablesContribution = contribution('consumables', ConsumablesStatusSchema, (slice) => {
  if (slice === undefined) return { consumables: { items: [], attention: 0 } }
  const items = slice.items.map((item) => ({
    key: item.key,
    label: item.label,
    level: item.level,
    needsAttention: item.status !== null && ATTENTION_STATUSES.includes(item.status),
  }))
  const attention = items.filter((i) => i.needsAttention).length
  return {
    consumables: { items, attention },
    ...(attention === 0
      ? {}
      : {
          facts: [
            fact(
              'consumables',
              null,
              heroText(`${attention} to check`, `${attention} da controllare`),
              'warning',
            ),
          ],
        }),
  }
})

// ── dishwasher ─────────────────────────────────────────────────────────────

const pct = (n: number): HeroText => heroText(`${Math.round(n)}%`, `${Math.round(n)}%`)

const dishCycle = (
  id: string,
  en: string,
  it: string,
  icon: VocabIcon,
  method: string,
  emphasis: 'primary' | 'normal' = 'normal',
): HeroControl =>
  asAction(action(`cycle.${id}`, heroText(en, it), icon, 'dishwasher', method, {}, emphasis))

/** Pause / resume / stop, per what the appliance is doing; nothing while it is not running. */
function dishwasherCycleControls(state: DishwasherStatus['state'] | undefined): HeroControl[] {
  if (state === 'running') {
    return [
      dishCycle('pause', 'Pause', 'Pausa', 'pause', 'pause'),
      dishCycle('stop', 'Stop', 'Stop', 'square', 'stop'),
    ]
  }
  if (state === 'paused') {
    return [
      dishCycle('resume', 'Resume', 'Riprendi', 'play', 'resume', 'primary'),
      dishCycle('stop', 'Stop', 'Stop', 'square', 'stop'),
    ]
  }
  return []
}

const OPERATION_WORDS: Readonly<Record<string, HeroText>> = {
  Run: heroText('Running', 'In corso'),
  Pause: heroText('Paused', 'In pausa'),
  Finished: heroText('Finished', 'Finito'),
  Ready: heroText('Ready', 'Pronta'),
  Inactive: heroText('Idle', 'Inattiva'),
  DelayedStart: heroText('Delayed start', 'Avvio ritardato'),
  ActionRequired: heroText('Action needed', 'Serve un intervento'),
  Error: heroText('Error', 'Errore'),
  Aborting: heroText('Stopping', 'Arresto'),
}

const dishwasherContribution = contribution('dishwasher', DishwasherStatusSchema, (slice, ctx) => {
  const state: HeroState =
    slice === undefined || slice.state === 'unavailable'
      ? 'unknown'
      : slice.state === 'running'
        ? 'running'
        : slice.state === 'error'
          ? 'alert'
          : 'idle'
  const rows: HeroRow[] = []
  const progress = slice?.progress ?? null
  if (progress !== null) {
    rows.push({
      id: 'progress',
      icon: 'activity',
      status: pct(progress),
      controls: [],
      progress: progress / 100,
    })
  }
  const cycle = dishwasherCycleControls(slice?.state)
  if (cycle.length > 0) rows.push({ id: 'cycle', icon: 'activity', status: null, controls: cycle })
  // Its PowerState is the appliance's main power, a secondary row action — never the own-power slot.
  if (slice?.powerOn != null) {
    rows.push({
      id: 'appliance-power',
      icon: 'power',
      status: slice.powerOn ? heroText('Powered on', 'Acceso') : heroText('Standby', 'In standby'),
      controls: [
        {
          kind: 'toggle',
          id: 'appliance-power.toggle',
          label: heroText('Appliance power', 'Alimentazione elettrodomestico'),
          on: slice.powerOn,
          turnOn: action(
            'appliance-power.on',
            heroText('Power on', 'Accendi'),
            'power',
            'dishwasher',
            'setPower',
            { on: true },
          ),
          turnOff: action(
            'appliance-power.off',
            heroText('Standby', 'Standby'),
            'power-off',
            'dishwasher',
            'setPower',
            { on: false },
          ),
        },
      ],
    })
  }
  const remaining = slice?.remaining ?? null
  const phase =
    slice?.operationState == null ? null : (OPERATION_WORDS[slice.operationState] ?? null)
  const program = slice?.program ?? slice?.selectedProgram ?? null
  const left: HeroSideTile[] = [
    ...(phase === null ? [] : [{ label: heroText('Phase', 'Fase'), value: phase }]),
    ...(program === null
      ? []
      : [{ label: heroText('Program', 'Programma'), value: heroText(program, program) }]),
  ]
  return {
    reading: reading('dishwasher', state),
    rows,
    ...(remaining === null
      ? {}
      : { facts: [fact('remaining', 'timer', minutesLeft(remaining), 'primary')] }),
    tiles: {
      left,
      ...(remaining === null
        ? {}
        : {
            right: [
              {
                label: heroText('Ends', 'Fine'),
                value: minutesLeft(remaining),
                tone: 'warning' as const,
                at: ctx.now + remaining * 1000,
              },
              { label: heroText('Left', 'Restano'), value: minutesLeft(remaining) },
            ],
          }),
    },
    ...(progress === null ? {} : { scene: { level: progress / 100 } }),
  }
})

// ── media-player ───────────────────────────────────────────────────────────

const has = (ctx: HeroContext, f: DeviceFeature): boolean => ctx.features.includes(f)

function mediaReading(view: MediaPlayerView): StateReading {
  if (view.power === 'unknown') return reading('media-player', 'unknown')
  if (view.power === 'off') return reading('media-player', 'off', view.stateAssumed)
  if (view.power === 'standby') return reading('media-player', 'standby', view.stateAssumed)
  if (view.running === 'playing' || view.running === 'buffering') {
    return reading('media-player', 'running', view.stateAssumed)
  }
  return reading('media-player', view.running === 'none' ? 'on' : 'idle', view.stateAssumed)
}

const mp = (
  id: string,
  en: string,
  it: string,
  icon: VocabIcon,
  method: string,
  emphasis: 'primary' | 'normal' = 'normal',
): HeroControl =>
  asAction(action(`playback.${id}`, heroText(en, it), icon, 'media-player', method, {}, emphasis))

function playbackControls(view: MediaPlayerView, ctx: HeroContext): HeroControl[] {
  const controls: HeroControl[] = []
  const stop = has(ctx, DeviceFeature.MediaPlayerStop)
  if (view.power === 'unknown') {
    // Nothing is known: every declared action is offered separately, none is guessed.
    controls.push(
      mp('play', 'Play', 'Riproduci', 'play', 'play'),
      mp('pause', 'Pause', 'Pausa', 'pause', 'pause'),
    )
    if (stop) controls.push(mp('stop', 'Stop', 'Stop', 'square', 'stop'))
    return controls
  }
  if (view.power !== 'on') return controls
  if (view.transport.previous)
    controls.push(mp('previous', 'Previous', 'Precedente', 'skip-back', 'previous'))
  if (view.transport.playPause) {
    if (view.running === 'playing' || view.running === 'buffering') {
      controls.push(mp('pause', 'Pause', 'Pausa', 'pause', 'pause', 'primary'))
    } else if (view.running === 'none') {
      controls.push(
        mp('play', 'Play', 'Riproduci', 'play', 'play'),
        mp('pause', 'Pause', 'Pausa', 'pause', 'pause'),
      )
    } else {
      controls.push(mp('play', 'Play', 'Riproduci', 'play', 'play', 'primary'))
    }
  }
  if (view.transport.stop) controls.push(mp('stop', 'Stop', 'Stop', 'square', 'stop'))
  if (view.transport.next) controls.push(mp('next', 'Next', 'Successivo', 'skip-forward', 'next'))
  return controls
}

function volumeControls(
  view: MediaPlayerView,
  volumeLevel: number | null,
  muted: boolean | null,
): HeroControl[] {
  const controls: HeroControl[] = []
  if (view.volume === 'slider') {
    controls.push({
      kind: 'slider',
      id: 'volume.level',
      label: heroText('Volume', 'Volume'),
      value: view.volumeKnown ? volumeLevel : null,
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      call: { cap: 'media-player', method: 'setVolume', args: {} },
      valueArg: 'volumeLevel',
    })
  }
  if (view.volume === 'steps') {
    controls.push(
      asAction(
        action(
          'volume.down',
          heroText('Volume down', 'Volume giù'),
          'volume-1',
          'media-player',
          'volumeDown',
        ),
      ),
      asAction(
        action(
          'volume.up',
          heroText('Volume up', 'Volume su'),
          'volume-2',
          'media-player',
          'volumeUp',
        ),
      ),
    )
  }
  if (view.mute) {
    controls.push({
      kind: 'toggle',
      id: 'volume.mute',
      label: heroText('Mute', 'Muto'),
      on: view.muteKnown ? muted : null,
      turnOn: action(
        'volume.mute',
        heroText('Mute', 'Muto'),
        'volume-x',
        'media-player',
        'setMute',
        { muted: true },
      ),
      turnOff: action(
        'volume.unmute',
        heroText('Unmute', 'Riattiva'),
        'volume-2',
        'media-player',
        'setMute',
        { muted: false },
      ),
    })
  }
  return controls
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const REPEAT_MODES = ['off', 'all', 'one'] as const

/** Shuffle and repeat, drawn only when the player declares them and reports a value. */
function modeControls(
  view: MediaPlayerView,
  shuffle: boolean | null,
  repeat: string | null,
): HeroControl[] {
  const controls: HeroControl[] = []
  if (view.shuffle) {
    controls.push({
      kind: 'toggle',
      id: 'playback.shuffle',
      label: heroText('Shuffle', 'Casuale'),
      on: shuffle,
      turnOn: action(
        'playback.shuffle.on',
        heroText('Shuffle on', 'Casuale attivo'),
        'shuffle',
        'media-player',
        'setShuffle',
        { shuffle: true },
      ),
      turnOff: action(
        'playback.shuffle.off',
        heroText('Shuffle off', 'Casuale disattivo'),
        'shuffle',
        'media-player',
        'setShuffle',
        { shuffle: false },
      ),
    })
  }
  if (view.repeat) {
    controls.push({
      kind: 'picker',
      id: 'playback.repeat',
      label: heroText('Repeat', 'Ripeti'),
      current: repeat,
      options: [...REPEAT_MODES],
      call: { cap: 'media-player', method: 'setRepeat', args: {} },
      valueArg: 'repeat',
    })
  }
  return controls
}

const mediaPlayerContribution = contribution(
  'media-player',
  MediaPlayerStatusSchema,
  (slice, ctx) => {
    const view = deriveMediaPlayerView(slice, ctx.features, {
      running: ctx.running,
    })
    const rows: HeroRow[] = []
    const playing = view.nowPlaying
    if (playing !== null && (playing.title !== null || playing.subtitle !== null)) {
      const line = [playing.title, playing.subtitle]
        .filter((p): p is string => p !== null)
        .join(' — ')
      rows.push({
        id: 'now-playing',
        icon: 'music',
        status: heroText(line, line),
        controls: [],
      })
    }
    const playback = [
      ...playbackControls(view, ctx),
      ...modeControls(view, slice?.shuffle ?? null, slice?.repeat ?? null),
    ]
    if (playback.length > 0)
      rows.push({
        id: 'playback',
        icon: 'play',
        status: null,
        controls: playback,
      })
    const volume = volumeControls(view, slice?.volumeLevel ?? null, slice?.isMuted ?? null)
    if (volume.length > 0)
      rows.push({
        id: 'volume',
        icon: 'volume-2',
        status: null,
        controls: volume,
      })
    if (view.channel !== null) {
      const channel = view.channel.current
      rows.push({
        id: 'channel',
        icon: 'tv',
        status: channel === null ? null : heroText(channel, channel),
        controls: [
          asAction(
            action(
              'channel.down',
              heroText('Channel down', 'Canale giù'),
              'chevron-down',
              'media-player',
              'channelDown',
            ),
          ),
          asAction(
            action(
              'channel.up',
              heroText('Channel up', 'Canale su'),
              'chevron-up',
              'media-player',
              'channelUp',
            ),
          ),
        ],
      })
    }
    if (view.source !== null) {
      const current = view.source.current === '' ? null : view.source.current
      rows.push({
        id: 'source',
        icon: 'radio',
        status: current === null ? null : heroText(current, current),
        controls: view.source.selectable
          ? [
              {
                kind: 'picker',
                id: 'source.pick',
                label: heroText('Source', 'Sorgente'),
                current,
                options: [...view.source.options],
                call: { cap: 'media-player', method: 'selectSource', args: {} },
                valueArg: 'source',
              },
            ]
          : [],
      })
    }
    const volumeNow = view.volumeKnown ? (slice?.volumeLevel ?? null) : null
    const sourceNow =
      view.source === null || view.source.current === '' ? null : view.source.current
    const mode =
      view.running === 'playing' ? 'playing' : view.running === 'paused' ? 'paused' : null
    const facts: HeroFact[] = []
    if (sourceNow !== null) facts.push(fact('source', 'radio', heroText(sourceNow, sourceNow)))
    if (volumeNow !== null) {
      facts.push(fact('volume', 'volume-2', heroText(`${volumeNow}%`, `${volumeNow}%`)))
    }
    const duration = slice?.duration ?? null
    const position = slice === undefined ? null : projectedPositionMs(slice, ctx.now)
    if (position !== null && duration !== null && duration > 0) {
      const line = `${clock(position)} / ${clock(duration)}`
      facts.push(fact('progress', 'activity', heroText(line, line)))
    }
    return {
      reading: mediaReading(view),
      facts,
      ...(volumeNow === null
        ? {}
        : {
            tiles: {
              right: [
                {
                  label: heroText('Volume', 'Volume'),
                  value: heroText(`${volumeNow}%`, `${volumeNow}%`),
                },
              ],
            },
          }),
      scene: {
        ...(mode === null ? {} : { mode }),
        ...(volumeNow === null ? {} : { level: volumeNow / 100 }),
      },
      ...(view.canSwitchPower
        ? {
            ownPower: {
              source: 'media-player' as const,
              on: view.power === 'unknown' ? null : view.power === 'on',
              assumed: view.stateAssumed,
              turnOn: action(
                'own-power.on',
                heroText('Turn on', 'Accendi'),
                'power',
                'media-player',
                'turnOn',
              ),
              turnOff: action(
                'own-power.off',
                heroText('Turn off', 'Spegni'),
                'power-off',
                'media-player',
                'turnOff',
              ),
            },
          }
        : {}),
      ...(view.artworkUrl === null ? {} : { artworkUrl: view.artworkUrl }),
      rows,
    }
  },
)

export type { HeroContribution } from './hero-contribution-kit.js'

/** Every contributing cap, in the order their fragments are merged. */
export const HERO_CAP_CONTRIBUTIONS: readonly HeroContribution[] = [
  mediaPlayerContribution,
  switchContribution,
  runningStateContribution,
  powerMeterContribution,
  batteryContribution,
  networkLinkContribution,
  contactContribution,
  motionTriggerContribution,
  timedRunContribution,
  powerSourceContribution,
  remoteContribution,
  consumablesContribution,
  dishwasherContribution,
  ...Object.values(ACCESS_FAMILY_CONTRIBUTIONS),
  ...Object.values(DEVICES_FAMILY_CONTRIBUTIONS),
  ...Object.values(GROUPS_FAMILY_CONTRIBUTIONS),
  ...Object.values(ACTUATORS_FAMILY_CONTRIBUTIONS),
  ...Object.values(SENSORS_FAMILY_CONTRIBUTIONS),
  ...Object.values(CLIMATE_FAMILY_CONTRIBUTIONS),
]
