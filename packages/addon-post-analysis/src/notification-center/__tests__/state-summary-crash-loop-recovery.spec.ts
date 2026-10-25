/**
 * D708 — a crash-looped runner that is RUNNING again is not in the summary.
 *
 * The 2026-10-06 12:00 summary said "hub — core-block-01b86c71… stopped after
 * repeated crashes (since 4 Oct)" for a core block that crash-looped on
 * 2026-10-04 and had been running since. A core block emits no
 * `addon.started`, so nothing closed its row. The summary now reads the
 * runner's state once per summary; only a POSITIVE answer closes the row, and
 * a read that fails changes nothing (D49).
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords } from './support/nc-test-deps.js'
import { NcRuleInputSchema, scheduleForSendTimes } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcTargetRef } from '../dispatcher.js'
import { NotificationCenter } from '../index.js'
import type { NcRunnerStateReads, NcRunnerStatusEntry } from '../state-summary/runner-recovery.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'

const TARGETS: NcTargetRef[] = [
  { id: 'target-1', addonId: 'notifiers', name: 'phone', kind: 'ntfy', enabled: true },
]
const NOON = scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 12 * 60 }], 'UTC')
const BLOCK_ID = '01b86c71-aaaa-bbbb-cccc-000000000001'
const RUNNER = `core-block-${BLOCK_ID}`

interface Runners {
  blocks: readonly NcRunnerStatusEntry[] | Error
  addons: readonly NcRunnerStatusEntry[] | Error
}

function reads(state: Runners): NcRunnerStateReads {
  return {
    coreBlocks: async () => {
      if (state.blocks instanceof Error) throw state.blocks
      return state.blocks
    },
    nodeAddons: async () => {
      if (state.addons instanceof Error) throw state.addons
      return state.addons
    },
  }
}

function makeCenter(
  world: InMemoryRecords,
  clock: { now: number },
  runners: Runners,
): NotificationCenter {
  return new NotificationCenter({
    deviceSettings: makeFakeDeviceSettings(),
    records: world.records,
    logger: makeSilentLogger(),
    pruneWindows: async () => ({
      outboxMs: null,
      timelapseExportMs: null,
      artifactShelfMs: null,
      summaryMosaicMs: null,
    }),
    now: () => clock.now,
    dispatcher: {
      listTargets: async () => TARGETS,
      send: async () => ({ success: true }),
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'x',
    },
    listObjectEventsSince: async () => [],
    listRecentTracks: async () => [],
    listDeviceIdentities: async () => [],
    readNodeDirectory: async () => ({
      nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
      complete: true,
    }),
    readRunnerStates: reads(runners),
    drainIntervalMs: 3_600_000,
    ruleReloadIntervalMs: 3_600_000,
  })
}

function crashLoop(center: NotificationCenter, at: number, runnerId: string, addonIds: string[]) {
  center.onSystemEvent({
    id: `runner-failed-${runnerId}`,
    timestamp: new Date(at),
    source: { type: 'core', id: runnerId, nodeId: 'hub' },
    category: 'addon.runner-failed',
    data: { runnerId, nodeId: 'hub', addonIds, crashesInWindow: 5, windowMs: 60_000 },
  })
}

const RULE = NcRuleInputSchema.parse({
  name: 'Sistema',
  delivery: 'system-event',
  conditions: { systemEvent: { kinds: ['addon-crash-loop'] } },
  systemEventDelivery: { mode: 'summary', schedule: NOON, split: 'section' },
  targets: [{ targetId: 'target-1' }],
})

const DAY_1 = Date.UTC(2026, 9, 4, 6, 21)
const DAY_2 = Date.UTC(2026, 9, 6, 11, 59)

describe('a crash-looped runner running again leaves the summary (D708)', () => {
  const centers: NotificationCenter[] = []
  afterEach(async () => {
    await Promise.all(centers.map((center) => center.stop()))
    centers.length = 0
  })

  async function started(runners: Runners, clock: { now: number }) {
    const world = makeNcRecords()
    const center = makeCenter(world, clock, runners)
    centers.push(center)
    await center.start({ evaluation: true })
    await center.whenHydrated()
    return center
  }

  it('crash-loop on day 1, the core block running on day 2 → not listed, and the row is closed', async () => {
    const clock = { now: DAY_1 }
    const runners: Runners = { blocks: [{ id: BLOCK_ID, status: 'failed' }], addons: [] }
    const center = await started(runners, clock)
    crashLoop(center, DAY_1, RUNNER, [])
    const provider = center.buildProvider()
    const day1 = await provider.previewStateSummary({ rule: RULE })
    expect(day1.count).toBe(1)
    expect(day1.text).toContain(RUNNER)

    clock.now = DAY_2
    runners.blocks = [{ id: BLOCK_ID, status: 'running' }]
    const day2 = await provider.previewStateSummary({ rule: RULE })
    expect(day2.count).toBe(0)
    expect(day2.empty).toBe(true)
    // CLOSED, not hidden: a later read that cannot answer does not bring it back.
    runners.blocks = new Error('core-blocks unreachable')
    expect((await provider.previewStateSummary({ rule: RULE })).count).toBe(0)
  })

  it('a runner state read that FAILS changes nothing — the crash-loop stays reported', async () => {
    const clock = { now: DAY_1 }
    const runners: Runners = { blocks: new Error('timeout'), addons: new Error('timeout') }
    const center = await started(runners, clock)
    crashLoop(center, DAY_1, RUNNER, [])
    crashLoop(center, DAY_1, 'recorder', ['recorder'])
    clock.now = DAY_2
    const preview = await center.buildProvider().previewStateSummary({ rule: RULE })
    expect(preview.count).toBe(2)
  })

  it('a block still failed, or an addon the node does not report, is no evidence of recovery', async () => {
    const clock = { now: DAY_1 }
    const runners: Runners = {
      blocks: [{ id: BLOCK_ID, status: 'failed' }],
      // `getNodeAddons` answers [] for an agent it could not reach.
      addons: [],
    }
    const center = await started(runners, clock)
    crashLoop(center, DAY_1, RUNNER, [])
    crashLoop(center, DAY_1, 'recorder', ['recorder'])
    clock.now = DAY_2
    const provider = center.buildProvider()
    expect((await provider.previewStateSummary({ rule: RULE })).count).toBe(2)
    // The addon runner's addon reported running → that row closes, the block's stays.
    runners.addons = [{ id: 'recorder', status: 'running' }]
    const after = await provider.previewStateSummary({ rule: RULE })
    expect(after.count).toBe(1)
    expect(after.text).toContain(RUNNER)
    expect(after.text).not.toContain('hub — recorder ')
  })
})
