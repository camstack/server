import { describe, expect, it } from 'vitest'
import type { ClimateControlStatus } from '../../../capabilities/climate-control.cap.js'
import type { MediaPlayerStatus } from '../../../capabilities/media-player.cap.js'
import { DeviceFeature, DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { HeroControl, HeroModel } from '../hero-model.js'
import { HeroRowModelSchema, projectDeviceRow } from '../hero-row.js'
import { build } from './hero-test-kit.js'

const idOf = (c: HeroControl): string => (c.kind === 'action' ? c.action.id : c.id)
const ids = (controls: readonly HeroControl[] | undefined): string[] => (controls ?? []).map(idOf)

const AC: ClimateControlStatus = {
  mode: 'heat',
  availableModes: ['off', 'heat', 'cool'],
  fanMode: 'auto',
  availableFanModes: [],
  preset: '',
  availablePresets: [],
  target: 22,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: 21,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: 16,
  maxTemp: 30,
  tempStep: 1,
  lastFetchedAt: 1,
}

const vacuum = (state: string) => ({
  'vacuum-control': {
    state,
    batteryLevel: 64,
    fanSpeed: null,
    availableFanSpeeds: [],
    progress: null,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: 0,
  },
})

const mower = (activity: string) => ({
  'lawn-mower-control': {
    activity,
    batteryLevel: 58,
    progress: null,
    currentCode: null,
    currentCodeLabel: null,
    severity: 'info',
    lastChangedAt: 0,
  },
})

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

function media(remoteCommands: number | null, caps: readonly string[]): HeroModel {
  return buildHeroModel({
    device: { id: 7, type: DeviceType.MediaPlayer, role: null, name: 'TV', online: true },
    caps,
    features: [DeviceFeature.MediaPlayerVolume],
    slices: { 'media-player': MEDIA },
    now: 1_700_000_000_000,
    remoteCommands,
    access: { canActuate: true },
  })
}

describe('row extras', () => {
  it('climate: mode is the primary, temperature the extra, no power toggle', () => {
    for (const type of [DeviceType.Climate, DeviceType.Climate]) {
      const row = projectDeviceRow(build(type, ['climate-control'], { 'climate-control': AC }))
      expect(ids(row.primary === null ? [] : [row.primary])).toEqual(['climate.mode'])
      expect(ids(row.extras)).toEqual(['climate.target'])
      const gated = projectDeviceRow({
        ...build(type, ['climate-control'], { 'climate-control': AC }),
        gated: ['climate-mode'],
      })
      expect(ids(gated.primary === null ? [] : [gated.primary])).toEqual(['own-power'])
      expect(ids(gated.extras)).toEqual(['climate.target'])
    }
  })

  it('vacuum and mower: return to base; start/pause stays the one primary', () => {
    const vac = projectDeviceRow(build(DeviceType.Vacuum, ['vacuum-control'], vacuum('cleaning')))
    expect(ids(vac.primary === null ? [] : [vac.primary])).toEqual(['vacuum.pause'])
    expect(ids(vac.extras)).toEqual(['vacuum.base'])
    const idle = projectDeviceRow(build(DeviceType.Vacuum, ['vacuum-control'], vacuum('idle')))
    expect(ids(idle.primary === null ? [] : [idle.primary])).toEqual(['vacuum.start'])
    const mow = projectDeviceRow(
      build(DeviceType.LawnMower, ['lawn-mower-control'], mower('mowing')),
    )
    expect(ids(mow.primary === null ? [] : [mow.primary])).toEqual(['mower.pause'])
    expect(ids(mow.extras)).toEqual(['mower.dock'])
  })

  it('a robot that is docked has no return-to-base extra', () => {
    const row = projectDeviceRow(build(DeviceType.Vacuum, ['vacuum-control'], vacuum('docked')))
    expect(ids(row.extras)).toEqual([])
  })

  it('media with a remote: volume then the remote icon; without one, no remote', () => {
    const withRemote = projectDeviceRow(media(3, ['media-player', 'remote']))
    expect(ids(withRemote.extras)).toEqual(['volume.level', 'remote.open'])
    expect(ids(withRemote.primary === null ? [] : [withRemote.primary])).toEqual(['playback.pause'])
    expect(ids(projectDeviceRow(media(0, ['media-player', 'remote'])).extras)).toEqual([
      'volume.level',
    ])
    expect(ids(projectDeviceRow(media(null, ['media-player'])).extras)).toEqual(['volume.level'])
  })

  it('a gated part yields no control, as primary does', () => {
    const vac = build(DeviceType.Vacuum, ['vacuum-control'], vacuum('cleaning'))
    expect(ids(projectDeviceRow({ ...vac, gated: ['vacuum'] }).extras)).toEqual([])
    const tv = media(3, ['media-player', 'remote'])
    expect(ids(projectDeviceRow({ ...tv, gated: ['remote'] }).extras)).toEqual(['volume.level'])
    expect(ids(projectDeviceRow({ ...tv, gated: ['volume'] }).extras)).toEqual(['remote.open'])
  })

  it('other types carry none, and the row parses', () => {
    const sw = projectDeviceRow(
      build(DeviceType.Switch, ['switch'], { switch: { on: true, lastChangedAt: 1 } }),
    )
    expect(sw.extras).toEqual([])
    const row = projectDeviceRow(media(3, ['media-player', 'remote']))
    expect(HeroRowModelSchema.safeParse(row).success).toBe(true)
  })
})
