import { describe, expect, it } from 'vitest'
import type { MediaPlayerStatus } from '../../../capabilities/media-player.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { buildHeroModel, type HeroModelInput } from '../build-hero-model.js'
import { kindOf, PLUG_HEATER } from './hero-test-kit.js'
import type { HeroControl, HeroModel } from '../hero-model.js'
import { ICON_KEYS } from '../../icon-catalog.generated.js'

const NOW = 1_700_000_000_000

function build(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown> = {},
  extra: Partial<Omit<HeroModelInput, 'device' | 'caps' | 'slices'>> & {
    online?: boolean
    role?: string | null
  } = {},
): HeroModel {
  return buildHeroModel({
    device: {
      id: 7,
      ...kindOf(type, extra.role ?? null),
      name: 'Dev',
      online: extra.online ?? true,
    },
    caps,
    features: extra.features ?? [],
    slices,
    now: NOW,
    remoteCommands: extra.remoteCommands ?? null,
    access: extra.access ?? { canActuate: true },
  })
}

const MEDIA_BASE: MediaPlayerStatus = {
  state: 'off',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 0,
}

const DISHWASHER = {
  availability: 'available',
  state: 'idle',
  operationState: null,
  program: null,
  selectedProgram: null,
  availablePrograms: [],
  remaining: null,
  delayedStart: null,
  progress: null,
  doorOpen: null,
  doorLocked: null,
  remoteStartAllowed: null,
  remoteControlActive: null,
  localControlActive: null,
  powerOn: null,
  powerState: null,
  filterCleaningDue: null,
  machineCareDue: null,
  machineCareRemainingRuns: null,
  halfLoad: null,
  hygienePlus: null,
  extraDry: null,
  intensiveZone: null,
  varioSpeedPlus: null,
  childLock: null,
  activeEvents: [],
  errorCode: null,
  errorLabel: null,
  lastFetchedAt: 1,
}

const actionIds = (model: HeroModel, rowId: string): string[] =>
  (model.rows.find((r) => r.id === rowId)?.controls ?? []).flatMap((c: HeroControl) =>
    c.kind === 'action' ? [c.action.id] : [],
  )

describe('state: unknown is never off', () => {
  const HEATER = ['switch', 'running-state', 'power-meter', 'timed-run']

  it('a heater whose switch has not reported renders unknown, with an unknown power', () => {
    const model = build(PLUG_HEATER, HEATER)
    expect(model.state).toBe('unknown')
    expect(model.ownPower?.on).toBeNull()
    // Its own icon, quiet, with an empty value — never a question mark, never "Off".
    expect(model.look.icon).toBe('flame')
    expect(model.title.en).toBe('—')
  })

  it('a slice that does not parse is not an answer', () => {
    const model = build(PLUG_HEATER, HEATER, { switch: { on: 'yes' } })
    expect(model.state).toBe('unknown')
    expect(model.ownPower?.on).toBeNull()
  })

  it('a switch that reported off is off, and on is on', () => {
    expect(build(PLUG_HEATER, ['switch'], { switch: { on: false, lastChangedAt: 1 } }).state).toBe(
      'off',
    )
    expect(build(PLUG_HEATER, ['switch'], { switch: { on: true, lastChangedAt: 1 } }).state).toBe(
      'on',
    )
  })

  it('a heater switched off with a quiet meter is off, not idle', () => {
    const model = build(PLUG_HEATER, HEATER, {
      switch: { on: false, lastChangedAt: 1 },
      'running-state': {
        running: false,
        since: 1,
        source: 'native',
        phase: null,
        lastFetchedAt: 1,
      },
    })
    expect(model.state).toBe('off')
  })

  it('a reading from running-state outranks a bare switch', () => {
    const model = build(PLUG_HEATER, HEATER, {
      switch: { on: true, lastChangedAt: 1 },
      'running-state': { running: true, since: 1, source: 'native', phase: null, lastFetchedAt: 1 },
    })
    expect(model.state).toBe('running')
    expect(model.look.background).toBe('heat-rise')
  })

  it('a device that cannot be reached is offline whatever its slices say', () => {
    const model = build(
      PLUG_HEATER,
      ['switch'],
      { switch: { on: true, lastChangedAt: 1 } },
      { online: false },
    )
    expect(model.state).toBe('offline')
    expect(model.background.kind).toBe('state')
  })

  it('a measurement that failed is null, never 0: a battery with no level', () => {
    const model = build(DeviceType.Sensor, ['battery'], {
      battery: { level: null, charging: 'unknown', sleeping: false, lastUpdated: 1 },
    })
    expect(model.badges[0]).toMatchObject({ id: 'battery', value: null, tone: 'muted' })
  })
})

describe('the two power slots are never merged', () => {
  const RUNNING = { running: true, since: 1, source: 'native', phase: null, lastFetchedAt: 1 }

  it('a device with a switch and a power-source gets both, as distinct slots', () => {
    const model = build(PLUG_HEATER, ['switch', 'power-source', 'running-state'], {
      switch: { on: true, lastChangedAt: 1 },
      'power-source': { switchOn: true, offSeconds: 10, lastFetchedAt: 1 },
      'running-state': RUNNING,
    })
    expect(model.ownPower?.source).toBe('switch')
    expect(model.ownPower?.turnOff.call).toEqual({
      cap: 'switch',
      method: 'setState',
      args: { on: false },
    })
    expect(model.powerSupply?.powerOff.call.cap).toBe('power-source')
    expect(model.powerSupply?.restart.call.method).toBe('forceRestart')
  })

  it('a power-source alone is NOT the own power', () => {
    const model = build(DeviceType.Washer, ['power-source'], {
      'power-source': { switchOn: true, offSeconds: 10, lastFetchedAt: 1 },
    })
    expect(model.ownPower).toBeNull()
    expect(model.powerSupply?.on).toBe(true)
  })

  it('a switch alone has no power supply, and the supply never offers a timer', () => {
    const model = build(DeviceType.Switch, ['switch'], { switch: { on: true, lastChangedAt: 1 } })
    expect(model.powerSupply).toBeNull()
    const supply = build(PLUG_HEATER, ['power-source', 'timed-run'], {}).powerSupply
    expect(Object.keys(supply ?? {})).not.toContain('timedRun')
  })

  it('the off of the supply asks for a confirmation only while the device runs', () => {
    const slices = { 'power-source': { switchOn: true, offSeconds: 10, lastFetchedAt: 1 } }
    const running = build(DeviceType.Washer, ['power-source', 'running-state'], {
      ...slices,
      'running-state': RUNNING,
    })
    const idle = build(DeviceType.Washer, ['power-source', 'running-state'], {
      ...slices,
      'running-state': { ...RUNNING, running: false },
    })
    expect(running.powerSupply?.confirmOffWhileRunning).toBe(true)
    expect(running.powerSupply?.powerOff.confirm).toBe('off-while-running')
    expect(idle.powerSupply?.confirmOffWhileRunning).toBe(false)
  })

  it('no layout hides either slot: every device type shows both', () => {
    for (const type of Object.values(DeviceType)) {
      const model = build(type, ['switch', 'power-source'], {
        switch: { on: true, lastChangedAt: 1 },
        'power-source': { switchOn: true, offSeconds: 10, lastFetchedAt: 1 },
      })
      expect(model.ownPower, `${type} own power`).not.toBeNull()
      expect(model.powerSupply, `${type} power supply`).not.toBeNull()
    }
  })

  it('a media player with the power feature switches through the player; without it, not', () => {
    const slices = { 'media-player': { ...MEDIA_BASE, state: 'on' as const } }
    const withFeature = build(DeviceType.MediaPlayer, ['media-player'], slices, {
      features: [DeviceFeature.MediaPlayerPower],
    })
    expect(withFeature.ownPower?.source).toBe('media-player')
    expect(withFeature.ownPower?.turnOff.call.method).toBe('turnOff')
    expect(withFeature.ownPower?.on).toBe(true)
    expect(build(DeviceType.MediaPlayer, ['media-player'], slices).ownPower).toBeNull()
  })

  it('the player outranks a bound switch as the own power', () => {
    const model = build(
      DeviceType.MediaPlayer,
      ['media-player', 'switch'],
      {
        'media-player': { ...MEDIA_BASE, state: 'on' as const },
        switch: { on: false, lastChangedAt: 1 },
      },
      { features: [DeviceFeature.MediaPlayerPower] },
    )
    expect(model.ownPower?.source).toBe('media-player')
  })

  it('the dishwasher PowerState is a secondary row action, never the own power', () => {
    const model = build(DeviceType.Dishwasher, ['dishwasher'], {
      dishwasher: { ...DISHWASHER, state: 'idle', powerOn: true },
    })
    expect(model.ownPower).toBeNull()
    expect(model.rows.map((r) => r.id)).toContain('appliance-power')
  })
})

describe('timed run', () => {
  const HEATER = ['switch', 'timed-run']

  it('a heater offers the default run in row one, beside its power', () => {
    const model = build(PLUG_HEATER, HEATER, { switch: { on: false, lastChangedAt: 1 } })
    expect(model.rows[0]?.id).toBe('run-for')
    expect(actionIds(model, 'run-for')).toEqual(['timed-run.run'])
    expect(model.timedRun?.quickRun).toEqual({ duration: 30, unit: 'min' })
    expect(model.timedRun?.run.call.args).toEqual({ duration: 30, unit: 'min' })
  })

  it('once running, row one offers Stop and Restart', () => {
    const model = build(PLUG_HEATER, HEATER, {
      switch: { on: true, lastChangedAt: 1 },
      'timed-run': {
        activeUntil: NOW + 5 * 60_000,
        requestedBy: null,
        quickRun: null,
        lastFetchedAt: 1,
      },
    })
    expect(actionIds(model, 'run-for')).toEqual(['timed-run.cancel', 'timed-run.restart'])
    expect(model.timedRun?.activeUntil).toBe(NOW + 5 * 60_000)
  })

  it('a deadline already past is not a run in progress', () => {
    const model = build(PLUG_HEATER, HEATER, {
      'timed-run': { activeUntil: NOW - 1, requestedBy: null, quickRun: null, lastFetchedAt: 1 },
    })
    expect(model.timedRun?.activeUntil).toBeNull()
  })

  it('a type without a limit is offered no timed run', () => {
    expect(build(DeviceType.Switch, HEATER).timedRun).toBeNull()
  })
})

describe('media player', () => {
  const MP = ['media-player']

  it('an unanswered transport offers Play, Pause and Stop separately', () => {
    const model = build(
      DeviceType.MediaPlayer,
      MP,
      {},
      { features: [DeviceFeature.MediaPlayerStop] },
    )
    expect(model.state).toBe('unknown')
    expect(actionIds(model, 'playback')).toEqual([
      'playback.play',
      'playback.pause',
      'playback.stop',
    ])
  })

  it('without the Stop feature the unknown transport has no Stop', () => {
    const model = build(DeviceType.MediaPlayer, MP)
    expect(actionIds(model, 'playback')).toEqual(['playback.play', 'playback.pause'])
  })

  it('once playing, Play and Pause collapse into one primary Pause', () => {
    const model = build(DeviceType.MediaPlayer, MP, {
      'media-player': { ...MEDIA_BASE, state: 'playing' },
    })
    expect(model.state).toBe('running')
    expect(actionIds(model, 'playback')).toEqual(['playback.pause'])
  })

  it('off offers no transport', () => {
    expect(
      build(DeviceType.MediaPlayer, MP, { 'media-player': MEDIA_BASE }).rows.map((r) => r.id),
    ).not.toContain('playback')
  })

  const SOURCES = {
    ...MEDIA_BASE,
    state: 'on' as const,
    source: 'HDMI 1',
    availableSources: ['HDMI 1', 'HDMI 2'],
  }
  const pickers = (model: HeroModel): number =>
    (model.rows.find((r) => r.id === 'source')?.controls ?? []).filter((c) => c.kind === 'picker')
      .length

  it('the source can be picked only with the select-source feature', () => {
    const without = build(DeviceType.MediaPlayer, MP, { 'media-player': SOURCES })
    const withFeature = build(
      DeviceType.MediaPlayer,
      MP,
      { 'media-player': SOURCES },
      {
        features: [DeviceFeature.MediaPlayerSelectSource],
      },
    )
    expect(pickers(without)).toBe(0)
    expect(without.rows.find((r) => r.id === 'source')?.status).toEqual({
      en: 'HDMI 1',
      it: 'HDMI 1',
    })
    expect(pickers(withFeature)).toBe(1)
  })

  it('a declared volume is drawn even before the device reports a level', () => {
    const model = build(
      DeviceType.MediaPlayer,
      MP,
      { 'media-player': { ...MEDIA_BASE, state: 'on' } },
      {
        features: [DeviceFeature.MediaPlayerVolume],
      },
    )
    const slider = model.rows
      .find((r) => r.id === 'volume')
      ?.controls.find((c) => c.kind === 'slider')
    expect(slider).toMatchObject({ kind: 'slider', value: null })
  })

  it('the artwork is the background when the status carries an image, else the state animation', () => {
    const playing = { ...MEDIA_BASE, state: 'playing' as const }
    const art = build(DeviceType.MediaPlayer, MP, {
      'media-player': {
        ...playing,
        currentMedia: { type: 'music', title: 'T', imageUrl: 'https://img/a.jpg' },
      },
    })
    expect(art.background).toMatchObject({ kind: 'artwork', url: 'https://img/a.jpg' })
    const plain = build(DeviceType.MediaPlayer, MP, { 'media-player': playing })
    expect(plain.background).toEqual({ kind: 'state', token: 'glow', animation: 'equalizer' })
  })

  it('a running-state reading outranks a guessed state (infrared)', () => {
    const model = build(DeviceType.MediaPlayer, ['media-player', 'running-state'], {
      'media-player': {
        ...MEDIA_BASE,
        state: 'off',
        stateSource: 'assumed',
        assumedFields: ['state'],
      },
      'running-state': { running: true, since: 1, source: 'native', phase: null, lastFetchedAt: 1 },
    })
    expect(model.state).not.toBe('off')
    expect(model.stateAssumed).toBe(false)
  })
})

describe('corner slots', () => {
  it('the remote button is offered to ANY type that has the remote cap', () => {
    for (const type of [DeviceType.Washer, PLUG_HEATER, DeviceType.Switch, DeviceType.Generic]) {
      expect(build(type, ['remote'], {}, { remoteCommands: 3 }).remote).toMatchObject({
        commands: 3,
        open: { id: 'remote.open' },
      })
    }
  })

  it('no saved command means no button; not knowing how many still shows it', () => {
    expect(build(DeviceType.Switch, ['remote'], {}, { remoteCommands: 0 }).remote).toBeNull()
    expect(build(DeviceType.Switch, ['remote'], {}, { remoteCommands: null }).remote).toMatchObject(
      {
        commands: null,
      },
    )
    expect(build(DeviceType.Switch, [], {}, { remoteCommands: 3 }).remote).toBeNull()
  })

  it('consumption is ONE value: power in watts when metered, else the running state', () => {
    const running = { running: true, since: 1, source: 'native', phase: 'wash', lastFetchedAt: 1 }
    const both = build(DeviceType.Washer, ['power-meter', 'running-state'], {
      'power-meter': { power: 480, energy: 1.2, voltage: 230, lastFetchedAt: 1 },
      'running-state': running,
    })
    expect(both.consumption).toMatchObject({ kind: 'power', watts: 480 })
    const detail =
      both.consumption?.kind === 'power' ? both.consumption.detail.map((d) => d.unit) : []
    expect(detail).toEqual(['kWh', 'V'])
    const only = build(DeviceType.Washer, ['power-meter', 'running-state'], {
      'running-state': running,
    })
    expect(only.consumption).toMatchObject({ kind: 'running', running: true, phase: 'wash' })
    expect(build(DeviceType.Washer, []).consumption).toBeNull()
  })

  it('consumables show how many need attention', () => {
    const item = (key: string, status: 'ok' | 'low') => ({
      key,
      label: key,
      level: null,
      status,
      lastResetAt: null,
      resettable: true,
    })
    const model = build(DeviceType.Vacuum, ['consumables'], {
      consumables: { items: [item('brush', 'low'), item('filter', 'ok')], lastChangedAt: 1 },
    })
    expect(model.consumables).toMatchObject({ attention: 1 })
    expect(model.consumables?.items.map((i) => i.key)).toEqual(['brush', 'filter'])
  })
})

describe('layout selects rows, never slots', () => {
  it('a washer reads its phase in a tile, with no status-line row of its own', () => {
    const model = build(DeviceType.Washer, ['running-state'], {
      'running-state': {
        running: true,
        since: 1,
        source: 'native',
        phase: 'spin',
        lastFetchedAt: 1,
      },
    })
    expect(model.state).toBe('running')
    expect(model.look).toMatchObject({ background: 'drum', animation: 'tumble' })
    expect(model.rows).toEqual([])
    expect(model.sideTiles.left.map((t) => [t.label.en, t.value.en])).toEqual([['Phase', 'spin']])
  })

  it('a row the type does not carry is dropped even when its cap is bound', () => {
    const model = build(DeviceType.Washer, ['running-state', 'contact'], {
      contact: { entryOpen: true, lastChangedAt: 1 },
    })
    expect(model.rows.map((r) => r.id)).not.toContain('contact')
  })

  it('a contact sensor reads open / closed', () => {
    const open = build(DeviceType.Sensor, ['contact'], {
      contact: { entryOpen: true, lastChangedAt: 1 },
    })
    expect(open.rows[0]?.status?.en).toBe('Open')
    expect(build(DeviceType.Sensor, ['contact']).rows[0]?.status?.en).toBe('—')
  })

  it('a bound cap shows in provenance', () => {
    const model = build(DeviceType.Switch, ['switch'], { switch: { on: true, lastChangedAt: 1 } })
    expect(model.provenance).toContainEqual({ partId: 'own-power', cap: 'switch' })
  })
})

describe('access', () => {
  it('lists every part that acts on the device when the session may not, and none when it may', () => {
    const caps = ['switch', 'timed-run', 'power-source', 'remote']
    const slices = { switch: { on: true, lastChangedAt: 1 } }
    const denied = build(PLUG_HEATER, caps, slices, {
      remoteCommands: 2,
      access: { canActuate: false },
    })
    expect(denied.gated).toEqual(['own-power', 'timed-run', 'power-supply', 'remote', 'run-for'])
    expect(build(PLUG_HEATER, caps, slices, { remoteCommands: 2 }).gated).toEqual([])
  })

  it('a read-only fact is never gated', () => {
    const model = build(
      DeviceType.Sensor,
      ['contact', 'battery'],
      {},
      { access: { canActuate: false } },
    )
    expect(model.gated).toEqual([])
  })
})

describe('icons', () => {
  it('every icon a built model names is in the catalog', () => {
    const icons = new Set<string>(ICON_KEYS)
    const model = build(
      DeviceType.MediaPlayer,
      [
        'media-player',
        'switch',
        'power-source',
        'timed-run',
        'battery',
        'network-link',
        'motion-trigger',
        'running-state',
        'dishwasher',
        'contact',
      ],
      {
        'media-player': {
          ...MEDIA_BASE,
          state: 'on',
          source: 'a',
          availableSources: ['a', 'b'],
          currentMedia: { type: 'x', title: 'T' },
        },
      },
      { features: Object.values(DeviceFeature) },
    )
    const named = [
      model.look.icon,
      ...model.badges.map((b) => b.icon),
      ...model.rows.map((r) => r.icon),
    ]
    for (const icon of named) expect(icons.has(icon), icon).toBe(true)
    const actions = [
      model.ownPower?.turnOn,
      model.ownPower?.turnOff,
      model.powerSupply?.powerOn,
      model.powerSupply?.powerOff,
      model.powerSupply?.restart,
    ]
    for (const a of actions) if (a !== undefined) expect(icons.has(a.icon), a.id).toBe(true)
    for (const row of model.rows) {
      for (const c of row.controls) {
        const as =
          c.kind === 'action' ? [c.action] : c.kind === 'toggle' ? [c.turnOn, c.turnOff] : []
        for (const a of as) expect(icons.has(a.icon), a.id).toBe(true)
      }
    }
  })
})
