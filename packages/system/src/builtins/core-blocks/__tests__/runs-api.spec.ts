import { type AutomationRunTrace, coreBlockAddonId, createRecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { automationOwner, RunsLedger } from '../runs-ledger.js'
import { buildRunsApi } from '../runs-api.js'
import { recordingLogger } from './fixtures.js'

function trace(
  runId: string,
  outcome: AutomationRunTrace['outcome'],
  reason = 'x',
): AutomationRunTrace {
  return {
    runId,
    startedAt: 1,
    endedAt: 2,
    trigger: { kind: 'manual', outcome: 'pass', reason, vars: {} },
    conditions: [],
    steps: [],
    outcome,
    repeat: 1,
    lastAt: 2,
  }
}

async function world() {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const log = recordingLogger()
  const ledger = new RunsLedger({
    runs: records.kind(coreBlocksRecordKinds.runs),
    logger: log.logger,
  })
  return { api: buildRunsApi(ledger, log.logger), ledger, log, records }
}

const asBlock = (blockId: string) => ({ callerAddonId: coreBlockAddonId(blockId) })

describe('runs api — a block writes only its own row', () => {
  it('stores a trace and the stamp, and hands both back to the block', async () => {
    const w = await world()
    await w.api.reportAutomationRun({
      blockId: 'b1',
      trace: trace('r1', 'ran'),
      runStartedAt: 500,
      ...asBlock('b1'),
    })
    const state = await w.api.getAutomationRunState({ blockId: 'b1', ...asBlock('b1') })
    expect(state.lastRunStartedAt).toBe(500)
    expect(state.traces.map((t) => t.runId)).toEqual(['r1'])
  })

  it('refuses a report from another block, and from an unstamped caller, and logs it', async () => {
    const w = await world()
    await expect(
      w.api.reportAutomationRun({ blockId: 'b1', trace: trace('r1', 'ran'), ...asBlock('b2') }),
    ).rejects.toThrow(/not that block/)
    await expect(
      w.api.reportAutomationRun({ blockId: 'b1', trace: trace('r1', 'ran') }),
    ).rejects.toThrow(/unstamped/)
    expect((await w.ledger.get(automationOwner('b1'))).traces).toEqual([])
    expect(
      w.log.lines.filter((l) => l.level === 'warn' && l.message.includes('refused')),
    ).toHaveLength(2)
    await expect(w.api.getAutomationRunState({ blockId: 'b1', ...asBlock('b2') })).rejects.toThrow(
      /not that block/,
    )
  })

  it('keeps the ring to keepTraces, dropping skips before real runs', async () => {
    const w = await world()
    const report = (t: AutomationRunTrace) =>
      w.api.reportAutomationRun({ blockId: 'b1', trace: t, keepTraces: 2, ...asBlock('b1') })
    await report(trace('run-1', 'ran'))
    await report(trace('skip-1', 'skipped-conditions', 'a'))
    await report(trace('run-2', 'ran'))
    const { traces } = await w.api.getTraces({ blockId: 'b1' })
    expect(traces.map((t) => t.runId)).toEqual(['run-1', 'run-2'])
  })

  it('reports the last failure to the operator, and a later success clears it', async () => {
    const w = await world()
    const failed: AutomationRunTrace = {
      ...trace('f', 'failed'),
      steps: [{ path: 'actions.0', kind: 'cap', outcome: 'error', message: 'siren offline' }],
    }
    await w.api.reportAutomationRun({ blockId: 'b1', trace: failed, ...asBlock('b1') })
    expect((await w.api.getTraces({ blockId: 'b1' })).lastError).toBe('siren offline')
    await w.api.reportAutomationRun({ blockId: 'b1', trace: trace('ok', 'ran'), ...asBlock('b1') })
    expect((await w.api.getTraces({ blockId: 'b1' })).lastError).toBeNull()
  })

  it('refuses a report that carries nothing', async () => {
    const w = await world()
    await expect(w.api.reportAutomationRun({ blockId: 'b1', ...asBlock('b1') })).rejects.toThrow(
      /needs a trace or a runStartedAt/,
    )
  })

  it('a stamp-only report moves the cooldown stamp and keeps the ring', async () => {
    const w = await world()
    await w.api.reportAutomationRun({ blockId: 'b1', trace: trace('r1', 'ran'), ...asBlock('b1') })
    await w.api.reportAutomationRun({ blockId: 'b1', runStartedAt: 900, ...asBlock('b1') })
    const state = await w.api.getAutomationRunState({ blockId: 'b1', ...asBlock('b1') })
    expect(state.lastRunStartedAt).toBe(900)
    expect(state.traces).toHaveLength(1)
  })
})

describe('runs ledger sweep', () => {
  it('removes the rows of owners that are gone, and keeps the live ones', async () => {
    const w = await world()
    await w.ledger.report(automationOwner('live'), { trace: trace('a', 'ran') })
    await w.ledger.report(automationOwner('gone'), { trace: trace('b', 'ran') })
    const removed = await w.ledger.sweep(async () => new Set([automationOwner('live')]))
    expect(removed).toBe(1)
    expect((await w.ledger.get(automationOwner('live'))).traces).toHaveLength(1)
    expect((await w.ledger.get(automationOwner('gone'))).traces).toEqual([])
  })

  it('does not delete a row when the second look finds its owner (one stale read cannot destroy a ring)', async () => {
    const w = await world()
    await w.ledger.report(automationOwner('late'), { trace: trace('a', 'ran') })
    let looks = 0
    const removed = await w.ledger.sweep(async () => {
      looks += 1
      return looks === 1 ? new Set<string>() : new Set([automationOwner('late')])
    })
    expect(removed).toBe(0)
    expect((await w.ledger.get(automationOwner('late'))).traces).toHaveLength(1)
  })
})
