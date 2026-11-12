/**
 * #522 through the real centre: the reload tick (`reloadRules`) runs the
 * battery-cap census the centre was wired with, and an open `battery:5693`
 * episode closes once two ticks agree the provider is up and no longer
 * declares `battery`. While the provider holds no native binding at all the
 * episode stays open, however many ticks pass.
 */
import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { batteryCapCensusOver, type NcDeviceBindingsFacts } from '../alerts/battery-cap-census.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort, ncTable } from './support/nc-test-deps.js'

const STORAGE = 5693

const WITH_BATTERY: NcDeviceBindingsFacts = {
  entries: [
    { capName: 'numeric-sensor', kind: 'native' },
    { capName: 'battery', kind: 'native' },
  ],
}
const WITHOUT_BATTERY: NcDeviceBindingsFacts = {
  entries: [{ capName: 'numeric-sensor', kind: 'native' }],
}
const PROVIDER_DOWN: NcDeviceBindingsFacts = { entries: [] }

interface World {
  readonly center: NotificationCenter
  readonly records: ReturnType<typeof makeNcRecords>
  bindings: NcDeviceBindingsFacts
}

describe('#522 — the centre closes a battery episode whose device lost the cap', () => {
  const centers: NotificationCenter[] = []

  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
  })

  async function openEpisode(): Promise<World> {
    const records = makeNcRecords()
    const world: { bindings: NcDeviceBindingsFacts } = { bindings: WITH_BATTERY }
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: records.records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => [],
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => 'Battery (System)',
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      listDeviceIdentities: async () => [
        { deviceId: STORAGE, type: DeviceType.Sensor, name: 'Battery', isCamera: false },
      ],
      batteryCapCensus: batteryCapCensusOver(async () => world.bindings),
      drainIntervalMs: 3_600_000,
      ruleReloadIntervalMs: 40,
      readDeviceAlertSettings: () => ({
        batteryLowPercent: 20,
        renotifyMinutes: 0,
        notifyRecovery: true,
      }),
    })
    centers.push(center)
    await center.start({ evaluation: true })
    center.onSystemEvent({
      id: 'battery-slice',
      timestamp: new Date(),
      source: { type: 'device', id: STORAGE },
      category: 'device.state-changed',
      data: { deviceId: STORAGE, capName: 'battery', slice: { level: 19, lastUpdated: 5_000 } },
    })
    await vi.waitFor(
      () => {
        expect(ncTable(records, 'device-alerts').has(`battery:${STORAGE}`)).toBe(true)
      },
      { timeout: 2_000 },
    )
    return Object.assign(world, { center, records })
  }

  it('closes it once the provider, still up, stops declaring battery', async () => {
    const world = await openEpisode()
    // Several ticks with the cap: nothing moves.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(ncTable(world.records, 'device-alerts').has(`battery:${STORAGE}`)).toBe(true)
    world.bindings = WITHOUT_BATTERY
    await vi.waitFor(
      () => {
        expect(ncTable(world.records, 'device-alerts').has(`battery:${STORAGE}`)).toBe(false)
      },
      { timeout: 2_000 },
    )
  })

  it('keeps it while the provider holds no binding at all', async () => {
    const world = await openEpisode()
    world.bindings = PROVIDER_DOWN
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
    expect(ncTable(world.records, 'device-alerts').has(`battery:${STORAGE}`)).toBe(true)
  })
})
