/**
 * The notification centre's drain tick evicts held recorded cuts (re-review
 * R4): the dispatcher method alone was dead code until something calls it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher } from '../dispatcher.js'
import { makeNcRecords, ncPruneWindowsPort } from './support/nc-test-deps.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const centers: NotificationCenter[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(centers.map((c) => c.stop()))
  centers.length = 0
})

describe('recorded-cut eviction is driven by the drain tick', () => {
  it('each drain tick sweeps the held cuts', async () => {
    const swept = vi.spyOn(NcDispatcher.prototype, 'sweepRecordedCuts')
    const center = new NotificationCenter({
      deviceSettings: makeFakeDeviceSettings(),
      records: makeNcRecords().records,
      logger: makeSilentLogger(),
      pruneWindows: ncPruneWindowsPort(),
      dispatcher: {
        listTargets: async () => [],
        send: async () => ({ success: true }),
        getMediaForOwner: async () => [],
        getDeviceName: async () => null,
      },
      listObjectEventsSince: async () => [],
      listRecentTracks: async () => [],
      drainIntervalMs: 10,
      ruleReloadIntervalMs: 3_600_000,
    })
    centers.push(center)
    await center.start({ evaluation: true })
    await vi.waitFor(() => {
      expect(swept).toHaveBeenCalled()
    })
  })
})
