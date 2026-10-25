/**
 * "Update all nodes" must report a per-node OUTCOME.
 *
 * WHY THIS FILE EXISTS. On 2026-09-01 the operator ran "Update all nodes".
 * Both agents reached `@camstack/server@1.2.205`; the hub stayed on 1.2.201
 * and produced not one log line. The loop was:
 *
 *     try { await mutateAsync(...) } catch { }   // "a restart drops the
 *                                                //  socket, not a real failure"
 *
 * Two distinct holes, both proven on the live hub:
 *
 *  1. A REFUSAL is not an exception. `applyServerUpdate` returns
 *     `{accepted:false, message}` on six different branches; the loop read
 *     only `restarting` (and here, nothing at all). Every refusal was
 *     indistinguishable from a success. This half needs no guessing and is
 *     fixed outright.
 *  2. A THROWN error is genuinely ambiguous: the node we just armed restarting
 *     and a node whose forward timed out for real produce the same rejection.
 *     Guessing "restart, so fine" is what hid the failure. The rule (D58) is
 *     to gate on whether the work PERSISTED, so an ambiguous drop is
 *     reconciled by READING the node back — never assumed either way.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServerPackageStatus, ServerUpdateActionResult } from '@camstack/types'
import {
  orderForUpdateAll,
  updateAllNodes,
  type UpdateAllSeams,
  type UpdateAllTarget,
} from '../cluster-update-all'

const HUB: UpdateAllTarget = { id: 'hub', name: 'Hub', isHub: true }
const AGENT_A: UpdateAllTarget = { id: 'agent-a', name: 'Agent A', isHub: false }
const AGENT_B: UpdateAllTarget = { id: 'agent-b', name: 'Agent B', isHub: false }

function accepted(version: string): ServerUpdateActionResult {
  return { accepted: true, targetVersion: version, restarting: true, message: `Staged ${version}` }
}

function refused(message: string): ServerUpdateActionResult {
  return { accepted: false, targetVersion: null, restarting: false, message }
}

function status(over: Partial<ServerPackageStatus>): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: '1.2.201',
    nodeRuntimeVersion: '24.0.0',
    activeVersion: '1.2.201',
    previousVersion: null,
    seedVersion: '1.2.200',
    latestVersion: '1.2.205',
    updateAvailable: true,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: 0,
    ...over,
  }
}

function makeSeams(over: Partial<UpdateAllSeams>): UpdateAllSeams {
  return {
    apply: vi.fn(async () => accepted('1.2.205')),
    readStatus: vi.fn(async () => status({})),
    wait: async () => undefined,
    ...over,
  }
}

describe('orderForUpdateAll', () => {
  it('sequences agents first and the hub last', () => {
    expect(orderForUpdateAll([HUB, AGENT_A, AGENT_B]).map((n) => n.id)).toEqual([
      'agent-a',
      'agent-b',
      'hub',
    ])
  })
})

describe('updateAllNodes', () => {
  it('reaches the hub even when an agent drops the connection mid-response', async () => {
    const seen: string[] = []
    const seams = makeSeams({
      apply: async (routing) => {
        const id = routing.nodeId ?? 'hub'
        seen.push(id)
        if (id === 'agent-a') throw new Error('Request is timed out')
        return accepted('1.2.205')
      },
      // agent-a came back on the new version — the drop was the restart.
      readStatus: async () => status({ runningVersion: '1.2.205', updateAvailable: false }),
    })

    await updateAllNodes([HUB, AGENT_A], seams)

    expect(seen).toEqual(['agent-a', 'hub'])
  })

  it('reports a REFUSAL as refused, never as a success', async () => {
    const seams = makeSeams({
      apply: async () => refused('Refused: @camstack/server@1.2.205 is already running.'),
    })

    const reports = await updateAllNodes([HUB], seams)

    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe('refused')
    expect(reports[0]?.detail).toMatch(/already running/)
  })

  it('files a staging install that DIED as failed, not next to a refusal', async () => {
    const seams = makeSeams({
      apply: async () => ({
        accepted: false,
        targetVersion: '1.2.353',
        restarting: false,
        message: 'Staging failed: npm error code ECONNRESET',
        outcome: 'failed',
        reason: 'staging-failed',
        error: 'npm error code ECONNRESET',
      }),
    })

    const reports = await updateAllNodes([HUB], seams)

    expect(reports[0]?.outcome).toBe('failed')
    expect(reports[0]?.detail).toMatch(/ECONNRESET/)
  })

  it('confirms an ambiguous drop by READING the node back, not by assuming', async () => {
    const readStatus = vi.fn(async () =>
      status({ updateState: 'pending-restart', pendingVersion: '1.2.205' }),
    )
    const seams = makeSeams({
      apply: async () => {
        throw new Error('socket hang up')
      },
      readStatus,
    })

    const reports = await updateAllNodes([AGENT_A], seams)

    expect(readStatus).toHaveBeenCalled()
    expect(reports[0]?.outcome).toBe('applied')
  })

  it('calls a dropped connection FAILED when the node comes back unchanged', async () => {
    const seams = makeSeams({
      apply: async () => {
        throw new Error('Request is timed out')
      },
      // Answered, settled, still on the old version and still behind: nothing
      // was ever armed. The old `catch {}` reported this as a success.
      readStatus: async () => status({ updateState: 'idle', updateAvailable: true }),
    })

    const reports = await updateAllNodes([AGENT_A], seams)

    expect(reports[0]?.outcome).toBe('failed')
  })

  it('says UNCONFIRMED — never applied — when the node cannot be read back', async () => {
    const seams = makeSeams({
      apply: async () => {
        throw new Error('Request is timed out')
      },
      readStatus: async () => {
        throw new Error('node offline')
      },
    })

    const reports = await updateAllNodes([AGENT_A], seams)

    expect(reports[0]?.outcome).toBe('unconfirmed')
    expect(reports[0]?.detail).toMatch(/could not be confirmed/i)
  })

  it('keeps going after one node fails, and reports every node exactly once', async () => {
    const seams = makeSeams({
      apply: async (routing) => {
        if (routing.nodeId === 'agent-a') return refused('Refused: workspace checkout.')
        return accepted('1.2.205')
      },
    })

    const reports = await updateAllNodes([HUB, AGENT_A, AGENT_B], seams)

    expect(reports.map((r) => r.nodeId)).toEqual(['agent-a', 'agent-b', 'hub'])
    expect(reports.map((r) => r.outcome)).toEqual(['refused', 'applied', 'applied'])
  })

  it('routes the hub unpinned and every agent by nodeId', async () => {
    const routings: unknown[] = []
    const seams = makeSeams({
      apply: async (routing) => {
        routings.push(routing)
        return accepted('1.2.205')
      },
    })

    await updateAllNodes([HUB, AGENT_A], seams)

    expect(routings).toEqual([{ nodeId: 'agent-a' }, {}])
  })
})
