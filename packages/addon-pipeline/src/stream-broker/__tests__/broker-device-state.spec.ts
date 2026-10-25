/**
 * The broker's profile assignment and probe snapshots as per-device settings
 * (D870): written by diff, replaced authoritatively only for cameras the mirror
 * has seen, never written before a load answered, removed with the camera.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  BROKER_PROFILE_KEY,
  flattenByDevice,
  groupByDevice,
  PROBE_SNAPSHOTS_KEY,
  probeSnapshotsMirror,
  profileMapMirror,
  splitBrokerId,
} from '../broker-device-state.js'
import { makeFakeBrokerDeviceSettings } from './fake-broker-device-settings.js'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  // Documented type boundary: the mirror only ever calls `warn`.
  return logger as unknown as IScopedLogger
}

const A = { map: { main: 'native:main' }, auto: true }
const B = { map: { main: 'native:sub' }, auto: false }

describe('brokerProfile as a per-device setting', () => {
  it('writes only the cameras whose assignment changed', async () => {
    const settings = makeFakeBrokerDeviceSettings()
    const mirror = profileMapMirror(settings, silentLogger())
    await mirror.load()
    await mirror.replace(new Map([[7, A]]))
    await mirror.replace(
      new Map([
        [7, A],
        [9, B],
      ]),
    )
    expect(settings.writes).toEqual([7, 9])
    expect(settings.rows.get(9)).toEqual({ [BROKER_PROFILE_KEY]: B })
  })

  it('replace prunes a camera it has seen, and only that key of it', async () => {
    const settings = makeFakeBrokerDeviceSettings()
    settings.rows.set(7, { [BROKER_PROFILE_KEY]: A, other: 1 })
    const mirror = profileMapMirror(settings, silentLogger())
    await mirror.load()
    await mirror.replace(new Map())
    expect(settings.rows.get(7)).toEqual({ other: 1 })
  })

  it('refuses to write until a load answered, and a failed load throws', async () => {
    const settings = makeFakeBrokerDeviceSettings()
    settings.rows.set(7, { [BROKER_PROFILE_KEY]: A })
    const mirror = profileMapMirror(settings, silentLogger())
    await expect(mirror.replace(new Map())).rejects.toThrow(/never loaded/)
    settings.failReads(new Error('down'))
    await expect(mirror.load()).rejects.toThrow('down')
    expect(mirror.isLoaded).toBe(false)
    expect(settings.rows.get(7)).toEqual({ [BROKER_PROFILE_KEY]: A })
  })

  it('a value that does not parse costs that camera only', async () => {
    const settings = makeFakeBrokerDeviceSettings()
    settings.rows.set(7, { [BROKER_PROFILE_KEY]: A })
    settings.rows.set(9, { [BROKER_PROFILE_KEY]: 'garbage' })
    const loaded = await profileMapMirror(settings, silentLogger()).load()
    expect([...loaded.keys()]).toEqual([7])
  })
})

describe('probeSnapshots as a per-device setting', () => {
  const snap = { at: 1, codec: 'h264', bitrateKbps: 4000, idrIntervalMs: 2000, audio: null }

  it('groups broker ids by camera and back', () => {
    const grouped = groupByDevice({ '7/native:main': 1, '7/native:sub': 2, '9/x': 3 })
    expect(grouped.get(7)).toEqual({ 'native:main': 1, 'native:sub': 2 })
    expect([...flattenByDevice(grouped).keys()].toSorted()).toEqual([
      '7/native:main',
      '7/native:sub',
      '9/x',
    ])
    expect(splitBrokerId('not-a-broker')).toBeNull()
    expect(splitBrokerId('abc/x')).toBeNull()
  })

  it('stores one value per camera under the probeSnapshots key', async () => {
    const settings = makeFakeBrokerDeviceSettings()
    const mirror = probeSnapshotsMirror(settings, silentLogger())
    await mirror.load()
    const value = groupByDevice({ '7/native:main': snap })
    await mirror.replace(value)
    expect(settings.rows.get(7)?.[PROBE_SNAPSHOTS_KEY]).toEqual({ 'native:main': snap })
  })
})
