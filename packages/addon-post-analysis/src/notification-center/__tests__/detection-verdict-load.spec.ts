/**
 * The verdict ledger survives a respawn: its RAM mirror is reseeded from the
 * store at boot, and a read before that is refused rather than answered empty.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  NcDetectionVerdictLedger,
  type NcDetectionVerdictRecord,
} from '../detection-verdict-ledger.js'
import { NotificationCenter } from '../index.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import { makeNcRecords, ncPruneWindowsPort } from './support/nc-test-deps.js'

const ROW: NcDetectionVerdictRecord = {
  trackId: 'trk-1',
  deviceId: 101,
  verdict: 'wrong',
  suggestedClass: 'dog',
  userId: 'alice',
  ruleId: 'rule-1',
  ruleName: 'person at gate',
  at: 1_800_000_000_000,
}

function makeLedger(world: ReturnType<typeof makeNcRecords>): NcDetectionVerdictLedger {
  return new NcDetectionVerdictLedger({ records: world.records, logger: makeSilentLogger() })
}

const centers: NotificationCenter[] = []

function makeCenter(
  world: ReturnType<typeof makeNcRecords>,
  aliases: Readonly<Record<string, string>> = {},
): NotificationCenter {
  const center = new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: ncPruneWindowsPort(),
    dispatcher: {
      listTargets: async () => [],
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => null,
      buildActions: async () => [],
      publicUrlBase: async () => null,
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    resolveTrackAliasSync: (id: string) => aliases[id],
    now: () => ROW.at,
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
  centers.push(center)
  return center
}

afterEach(async () => {
  await Promise.all(centers.map((c) => c.stop()))
  centers.length = 0
})

describe('NcDetectionVerdictLedger.load', () => {
  it('returns a row recorded before the ledger was rebuilt on the same store', async () => {
    const world = makeNcRecords()
    await makeLedger(world).record(ROW)
    const respawned = makeLedger(world)
    expect(respawned.forTracks(['trk-1']).size).toBe(0)
    expect(respawned.hasAnswered()).toBe(false)
    await respawned.load()
    expect(respawned.hasAnswered()).toBe(true)
    expect(respawned.forTracks(['trk-1']).get('trk-1')).toEqual(ROW)
  })
})

describe('NotificationCenter and the verdict ledger across a respawn', () => {
  it('start() reseeds the verdicts, so the retrain view still sees them', async () => {
    const world = makeNcRecords()
    await makeLedger(world).record(ROW)
    const center = makeCenter(world)
    await center.start({ evaluation: false })
    expect(center.detectionVerdictsOf(['trk-1']).get('trk-1')?.verdict).toBe('wrong')
  })

  it('an id fused away still reads the answer recorded on its survivor', async () => {
    const world = makeNcRecords()
    await makeLedger(world).record({ ...ROW, trackId: 'trk-survivor' })
    const center = makeCenter(world, { 'trk-1': 'trk-survivor' })
    await center.start({ evaluation: false })
    const read = center.detectionVerdictsOf(['trk-1', 'trk-other'])
    expect(read.get('trk-1')?.verdict).toBe('wrong')
    expect(read.has('trk-other')).toBe(false)
  })

  it('refuses a read before the load instead of answering "no verdict"', async () => {
    const world = makeNcRecords()
    await makeLedger(world).record(ROW)
    const center = makeCenter(world)
    expect(() => center.detectionVerdictsOf(['trk-1'])).toThrow(/not loaded/)
  })
})
