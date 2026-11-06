/**
 * The washer's fake cycles: a finished appliance cycle whose CLOSED run record
 * says it was aborted or a standby blip is not announced - and the drop is
 * logged. Wired through the real facts resolver over fake run ports.
 */
import type { DeviceRun } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { applianceCycleFactsFromRuns } from '../appliance-cycle-runs.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'
import { makeRecordingLogger } from './device-prune-harness.js'

const FINISHED_AT = 1_753_000_000_000
const MIN = 60_000

function finishEntry(): NcOutboxEntry {
  return {
    id: 'r:1:t',
    ruleId: 'r',
    targetId: 't',
    deviceId: 7,
    recordKind: 'device-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      ruleName: 'Fine ciclo elettrodomestici',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 7,
        className: 'appliance-cycle',
        zones: [],
        timestamp: FINISHED_AT,
        applianceCycle: { deviceId: 7 },
      },
    },
  }
}

function run(over: Partial<DeviceRun>, energyKwh: number | null): DeviceRun {
  return {
    runId: '7:1',
    deviceId: 7,
    kind: 'appliance',
    state: 'closed',
    startedAt: FINISHED_AT - 60 * MIN,
    endedAt: FINISHED_AT,
    durationMs: 60 * MIN,
    outcome: 'completed',
    startSource: 'running-state',
    endSource: 'running-state',
    runningSource: 'native',
    phases: [],
    detail: {
      kind: 'appliance',
      energyKwh,
      energyMethod: energyKwh === null ? null : 'counter-delta',
      peakW: null,
      avgW: null,
      program: null,
      remainingAtStartSec: null,
      finalPhase: null,
      energyStartKwh: null,
      powerObservedMs: 0,
    },
    ...over,
  }
}

async function deliver(newest: DeviceRun | null) {
  const sends: NcSendInput[] = []
  const log = makeRecordingLogger()
  const dispatcher = new NcDispatcher({
    logger: log.logger,
    texts: new NcTextCatalog(),
    listTargets: async () => [
      {
        id: 't',
        addonId: 'notifiers',
        name: 'Phone',
        kind: 'pushover',
        enabled: true,
      },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Lavatrice',
    getZoneNames: async () => [],
    resolveApplianceCycleFacts: applianceCycleFactsFromRuns({
      newestRun: async () => newest,
      sleep: async () => undefined,
    }),
  })
  await dispatcher.deliver(finishEntry())
  return { sends, log }
}

describe('a finished cycle that was not a real run is not announced', () => {
  it('an aborted run: no send, one logged drop tagged with the device', async () => {
    const { sends, log } = await deliver(run({ outcome: 'aborted', durationMs: 90_000 }, 0.0001))
    expect(sends).toHaveLength(0)
    const drop = log.lines.find((l) => l.message.startsWith('notification dropped'))
    expect(drop?.tags).toEqual({ deviceId: 7 })
    expect(drop?.meta).toMatchObject({ reason: 'aborted' })
  })

  it('a 0.0001 kWh run (standby blip) is below the energy floor', async () => {
    const { sends, log } = await deliver(run({ durationMs: 10 * MIN }, 0.0001))
    expect(sends).toHaveLength(0)
    expect(log.lines.find((l) => l.message.startsWith('notification dropped'))?.meta).toMatchObject(
      { reason: 'below-energy-floor' },
    )
  })

  it('a run too short with unknown energy is dropped on duration', async () => {
    const { sends } = await deliver(run({ durationMs: 2 * MIN }, null))
    expect(sends).toHaveLength(0)
  })

  it('a real 1.4 kWh, 60 min run is notified', async () => {
    const { sends, log } = await deliver(run({}, 1.4))
    expect(sends).toHaveLength(1)
    expect(log.lines.some((l) => l.message.startsWith('notification dropped'))).toBe(false)
  })

  it('unknown energy on a long run, and no run record at all, still notify (D49)', async () => {
    expect((await deliver(run({}, null))).sends).toHaveLength(1)
    expect((await deliver(null)).sends).toHaveLength(1)
  })
})
