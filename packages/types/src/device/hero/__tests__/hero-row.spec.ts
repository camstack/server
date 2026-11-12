import { describe, expect, it } from 'vitest'
import type { MediaPlayerStatus } from '../../../capabilities/media-player.cap.js'
import { DeviceFeature, DeviceRole, DeviceType } from '../../device-type.js'
import { HERO_ROW_MODELS_MAX, heroLayoutCapability } from '../../../capabilities/hero-layout.cap.js'
import { buildHeroModel, type HeroModelInput } from '../build-hero-model.js'
import { kindOf, PLUG_HEATER } from './hero-test-kit.js'
import type { HeroModel } from '../hero-model.js'
import { HeroRowModelSchema, projectDeviceRow, ROW_STATUS_FACTS_MAX } from '../hero-row.js'
import {
  HERO_SCENE_BY_ROLE,
  HERO_SCENE_BY_TYPE,
  HERO_SCENES,
  HeroSceneSchema,
  resolveHeroSceneId,
} from '../hero-scene.js'

function build(
  type: string,
  caps: readonly string[],
  slices: Record<string, unknown> = {},
  extra: { features?: readonly string[]; canActuate?: boolean; role?: string | null } = {},
): HeroModel {
  const input: HeroModelInput = {
    device: { id: 7, ...kindOf(type, extra.role ?? null), name: 'Dev', online: true },
    caps,
    features: extra.features ?? [],
    slices,
    now: 1_700_000_000_000,
    remoteCommands: null,
    access: { canActuate: extra.canActuate ?? true },
  }
  return buildHeroModel(input)
}

const MEDIA: MediaPlayerStatus = {
  state: 'playing',
  stateSource: 'reported',
  assumedFields: [],
  volumeLevel: 40,
  isMuted: false,
  source: 'HDMI 1',
  availableSources: ['HDMI 1'],
  currentMedia: { type: 'music', title: 'Song', artist: 'Band' },
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 0,
}

const SWITCH_ON = { on: true, lastChangedAt: 1 }
const METER = { power: 1500.4, energy: 12, lastFetchedAt: 1 }
const BATTERY_LOW = { level: 15, charging: 'none', sleeping: false, lastUpdated: 1 }

describe('scene exhaustiveness', () => {
  it('every DeviceType and DeviceRole resolves to a declared scene', () => {
    for (const type of Object.values(DeviceType)) {
      expect(HERO_SCENES, type).toContain(HERO_SCENE_BY_TYPE[type])
      for (const role of Object.values(DeviceRole)) {
        expect(HERO_SCENES).toContain(resolveHeroSceneId(role, type))
      }
    }
    for (const role of Object.values(DeviceRole)) expect(HERO_SCENE_BY_ROLE[role]).toBeDefined()
  })

  it('every scene id is reachable from some type or role', () => {
    const used = new Set<string>([
      ...Object.values(HERO_SCENE_BY_TYPE),
      ...Object.values(HERO_SCENE_BY_ROLE).filter((s) => s !== 'inherit'),
    ])
    expect([...HERO_SCENES].filter((s) => !used.has(s))).toEqual([])
  })

  it('a role refines the type, an unknown type gets the terminal', () => {
    expect(resolveHeroSceneId(DeviceRole.ContactSensor, DeviceType.Sensor)).toBe('contact')
    expect(resolveHeroSceneId(null, DeviceType.Sensor)).toBe('sensor-sparkline')
    expect(resolveHeroSceneId(null, 'from-the-future')).toBe('generic')
  })
})

describe('the hero model names its scene, facts and tiles', () => {
  it('a media player says what it is doing and at which volume', () => {
    const m = build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': MEDIA })
    expect(HeroSceneSchema.parse(m.scene)).toEqual({ id: 'tv', mode: 'playing', level: 0.4 })
    expect(m.sideTiles.right[0]?.value.en).toBe('40%')
  })

  it('a scene that nobody has told its mode keeps null, never a guess', () => {
    const m = build(DeviceType.Lock, [])
    expect(m.scene).toEqual({ id: 'lock', mode: null, level: null })
  })

  it('never more than two tiles on a side', () => {
    const m = build(DeviceType.Sensor, ['power-meter', 'battery'], {
      'power-meter': METER,
      battery: BATTERY_LOW,
    })
    expect(m.sideTiles.left.length).toBeLessThanOrEqual(2)
    expect(m.sideTiles.right.length).toBeLessThanOrEqual(2)
    expect(m.sideTiles.left.map((t) => t.label.en)).toEqual(['Energy', 'Battery'])
  })
})

describe('projectDeviceRow', () => {
  it('climate: the scene is the airflow, no control without a bound cap', () => {
    const row = projectDeviceRow(build(DeviceType.Climate, [], {}, { role: DeviceRole.ClimateAc }))
    expect(row.scene.id).toBe('ac')
    expect(row.primary).toBeNull()
    expect(row.trailing).toBeNull()
    expect(row.statusLine.map((t) => t.en)).toEqual(['—'])
  })

  it('heater: the switch is the inline control, the watts trail', () => {
    const row = projectDeviceRow(
      build(PLUG_HEATER, ['switch', 'power-meter'], {
        switch: SWITCH_ON,
        'power-meter': METER,
      }),
    )
    expect(row.scene.id).toBe('heater')
    expect(row.primary).toMatchObject({ kind: 'toggle', id: 'own-power', on: true })
    expect(row.trailing).toMatchObject({ id: 'power', text: { en: '1500 W' } })
    expect(row.statusLine.map((t) => t.en)).toEqual(['On'])
    expect(row.timedRun).toBeNull()
  })

  it('a numeric-sensor reading trails the row for a fraction and for whole numbers', () => {
    for (const value of [6.9, 48, 1221]) {
      const row = projectDeviceRow(
        build(
          DeviceType.Sensor,
          ['numeric-sensor'],
          { 'numeric-sensor': { value, lastFetchedAt: 1 } },
          { role: DeviceRole.TemperatureSensor },
        ),
      )
      expect(row.trailing?.text.en).toBe(String(value))
      expect(row.statusLine.map((t) => t.en)).toEqual([String(value)])
    }
  })

  it('washer: the phase is in the status line, the drum is the scene', () => {
    const row = projectDeviceRow(
      build(DeviceType.Washer, ['running-state'], {
        'running-state': {
          running: true,
          since: 1,
          source: 'native',
          phase: 'spin',
          lastFetchedAt: 1,
        },
      }),
    )
    expect(row.scene.id).toBe('washer')
    expect(row.state).toBe('running')
    expect(row.statusLine.map((t) => t.en)).toEqual(['Running', 'spin'])
  })

  it('media player: what plays is the status line and play/pause is the control', () => {
    const row = projectDeviceRow(
      build(
        DeviceType.MediaPlayer,
        ['media-player'],
        { 'media-player': MEDIA },
        { features: [DeviceFeature.MediaPlayerStop] },
      ),
    )
    expect(row.statusLine[0]?.en).toBe('Song — Band')
    expect(row.primary?.kind).toBe('action')
    expect(row.scene).toMatchObject({ id: 'tv', mode: 'playing' })
  })

  it('lock: its own scene, unknown stays unknown', () => {
    const row = projectDeviceRow(build(DeviceType.Lock, []))
    expect(row.scene.id).toBe('lock')
    expect(row.state).toBe('unknown')
  })

  it('sensor: a flat battery trails in the danger tone', () => {
    const row = projectDeviceRow(build(DeviceType.Sensor, ['battery'], { battery: BATTERY_LOW }))
    expect(row.scene.id).toBe('sensor-sparkline')
    expect(row.trailing).toMatchObject({ id: 'battery', tone: 'danger' })
  })

  it('cover: the slats scene, an open door reads open on a contact sensor', () => {
    expect(projectDeviceRow(build(DeviceType.Cover, [])).scene.id).toBe('cover')
    const door = projectDeviceRow(
      build(
        DeviceType.Sensor,
        ['contact'],
        { contact: { entryOpen: true, lastChangedAt: 1 } },
        {
          role: DeviceRole.ContactSensor,
        },
      ),
    )
    expect(door.scene).toMatchObject({ id: 'contact', mode: 'open' })
  })

  it('pet feeder: the auger, and a low consumable trails', () => {
    const row = projectDeviceRow(
      build(DeviceType.PetFeeder, ['consumables'], {
        consumables: {
          items: [
            {
              key: 'food',
              label: 'Food',
              level: 5,
              status: 'low',
              lastResetAt: null,
              resettable: false,
            },
          ],
          lastChangedAt: 1,
        },
      }),
    )
    expect(row.scene.id).toBe('pet-feeder')
    expect(row.trailing).toMatchObject({ id: 'consumables', tone: 'warning' })
  })

  it('a caller that may not act gets no inline control', () => {
    const row = projectDeviceRow(
      build(PLUG_HEATER, ['switch'], { switch: SWITCH_ON }, { canActuate: false }),
    )
    expect(row.primary).toBeNull()
  })

  it('the row is a pure selection: it parses and carries only what the model holds', () => {
    const model = build(PLUG_HEATER, ['switch', 'power-meter'], {
      switch: SWITCH_ON,
      'power-meter': METER,
    })
    const row = projectDeviceRow(model)
    expect(HeroRowModelSchema.parse(row)).toEqual(row)
    expect(row.scene).toBe(model.scene)
    expect(row.look).toBe(model.look)
    expect(model.facts).toContain(row.trailing)
  })
})

const NOW = 1_700_000_000_000

const FOUNTAIN_SLICE = {
  waterLevel: 70,
  waterVolume: null,
  empty: false,
  pumpRunning: true,
  error: null,
  lastFetchedAt: 0,
}

describe('timed run on the row', () => {
  it('an armed heater keeps the power toggle and adds Stop plus the minutes left', () => {
    const row = projectDeviceRow(
      build(PLUG_HEATER, ['switch', 'timed-run'], {
        switch: SWITCH_ON,
        'timed-run': {
          activeUntil: NOW + 23 * 60_000,
          requestedBy: null,
          quickRun: { duration: 30, unit: 'min' },
          lastFetchedAt: 1,
        },
      }),
    )
    expect(row.primary).toMatchObject({ kind: 'toggle', id: 'own-power', on: true })
    expect(row.statusLine.map((t) => t.en)).toEqual(['On', '23 min'])
    expect(row.timedRun).toEqual({ id: 'timed-run.cancel', duration: 30, unit: 'min' })
  })

  it('an idle heater offers Run and does not invent a remaining time', () => {
    const row = projectDeviceRow(
      build(PLUG_HEATER, ['switch', 'timed-run'], {
        switch: SWITCH_ON,
        'timed-run': {
          activeUntil: null,
          requestedBy: null,
          quickRun: { duration: 30, unit: 'min' },
          lastFetchedAt: 1,
        },
      }),
    )
    expect(row.primary).toMatchObject({ kind: 'toggle', id: 'own-power' })
    expect(row.statusLine.map((t) => t.en)).toEqual(['On'])
    expect(row.timedRun).toEqual({ id: 'timed-run.run', duration: 30, unit: 'min' })
  })

  it('an armed fountain uses seconds and offers Stop beside its pump', () => {
    const row = projectDeviceRow(
      build(DeviceType.PetFountain, ['pet-fountain', 'timed-run'], {
        'pet-fountain': FOUNTAIN_SLICE,
        'timed-run': {
          activeUntil: NOW + 45_000,
          requestedBy: null,
          quickRun: { duration: 60, unit: 's' },
          lastFetchedAt: 1,
        },
      }),
    )
    expect(row.primary).toMatchObject({ kind: 'toggle', id: 'fountain.pump' })
    expect(row.statusLine.map((t) => t.en)).toContain('45 s')
    expect(row.timedRun).toEqual({ id: 'timed-run.cancel', duration: 60, unit: 's' })
  })

  it('a switch without the cap is unchanged', () => {
    const row = projectDeviceRow(build(DeviceType.Switch, ['switch'], { switch: SWITCH_ON }))
    expect(row.timedRun).toBeNull()
    expect(row.primary).toMatchObject({ kind: 'toggle', id: 'own-power' })
    expect(row.statusLine.map((t) => t.en)).toEqual(['On'])
  })
})

describe('getRowModels input', () => {
  it('is bounded: 500 ids pass, 501 are refused', () => {
    const input = heroLayoutCapability.methods.getRowModels.input
    const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
    expect(input.safeParse({ deviceIds: ids(HERO_ROW_MODELS_MAX) }).success).toBe(true)
    expect(input.safeParse({ deviceIds: ids(HERO_ROW_MODELS_MAX + 1) }).success).toBe(false)
  })
})

describe('row selection rules', () => {
  it('the status line is bounded and keeps the head first', () => {
    const model = build(PLUG_HEATER, ['switch'], { switch: SWITCH_ON })
    const fact = model.facts[0] ?? {
      id: 'phase' as const,
      icon: null,
      text: { en: 'x', it: 'x' },
      tone: 'muted' as const,
    }
    const many = { ...model, facts: Array.from({ length: 8 }, () => fact) }
    const row = projectDeviceRow(many)
    expect(row.statusLine).toHaveLength(1 + ROW_STATUS_FACTS_MAX)
    expect(row.statusLine[0]).toBe(model.title)
  })

  it('a gated first-row control means no inline control, never the next row', () => {
    const model = build(DeviceType.MediaPlayer, ['media-player'], { 'media-player': MEDIA })
    const first = model.rows.find((r) => r.controls.length > 0)
    expect(first).toBeDefined()
    const gated = { ...model, gated: [first?.id ?? ''] }
    expect(projectDeviceRow(gated).primary).toBeNull()
  })

  it('distinct pictures for the look-alike types', () => {
    const ids = [
      DeviceType.Climate,
      DeviceType.Fan,
      DeviceType.Washer,
      DeviceType.Dryer,
      DeviceType.Vacuum,
      DeviceType.LawnMower,
      DeviceType.MediaPlayer,
    ].map((t) => resolveHeroSceneId(null, t))
    expect(new Set(ids).size).toBe(ids.length)
    // D1033 — an air conditioner is a climate device told apart by its role.
    expect(resolveHeroSceneId(DeviceRole.ClimateAc, DeviceType.Climate)).toBe('ac')
    expect(resolveHeroSceneId(null, DeviceType.Climate)).toBe('thermostat')
    expect(resolveHeroSceneId(DeviceRole.Chime, DeviceType.MediaPlayer)).toBe('speaker')
  })
})
