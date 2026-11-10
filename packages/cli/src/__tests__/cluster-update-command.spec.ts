import { describe, expect, it } from 'vitest'
import { clusterUpdateCommand, type ClusterUpdateCommandDeps } from '../commands/cluster-update.js'
import { fakeHub } from './ops-fake-hub.js'

function step(kind: string, status: string, over: object = {}): object {
  return { kind, status, detail: `${kind} ${status}`, ...over }
}

const PLAN = {
  targetVersion: '2.0.0',
  steps: [step('backup', 'pending'), step('agent-server', 'pending', { nodeId: 'a1' })],
  skippedOffline: [],
  blocker: null,
  blockerDetail: null,
}

function job(state: string, steps: object[], over: object = {}): object {
  return {
    id: 'job-1',
    state,
    targetVersion: '2.0.0',
    requestedBy: 'admin',
    startedAt: 1,
    steps,
    skippedOffline: [],
    ...over,
  }
}

function harness(reads: object[], answers: { [path: string]: unknown } = {}) {
  let read = 0
  const hub = fakeHub({
    'clusterUpdate.previewClusterUpdate': PLAN,
    'clusterUpdate.startClusterUpdate': {
      accepted: true,
      jobId: 'job-1',
      blocker: null,
      message: 'started',
    },
    'clusterUpdate.getClusterUpdateJob': () => reads[Math.min(read++, reads.length - 1)],
    ...answers,
  })
  const lines: string[] = []
  let clock = 0
  const deps: ClusterUpdateCommandDeps = {
    print: (l) => lines.push(l),
    confirm: async () => true,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    pollMs: 1000,
    jobTimeoutMs: 5000,
  }
  return { hub, lines, deps }
}

async function clientOf(hub: ReturnType<typeof fakeHub>) {
  const outcome = await hub.ctx.hub()
  if (!outcome.ok) throw new Error('fake hub has no session')
  return outcome.connection.client
}

describe('camstack cluster-update', () => {
  it('starts the hub job with the options and exits 0 when it succeeds', async () => {
    const { hub, lines, deps } = harness([
      job('running', [
        step('backup', 'running'),
        step('agent-server', 'pending', { nodeId: 'a1' }),
      ]),
      job('succeeded', [step('backup', 'ok'), step('agent-server', 'ok', { nodeId: 'a1' })]),
    ])
    const code = await clusterUpdateCommand(await clientOf(hub), { backup: false, yes: true }, deps)
    expect(code).toBe(0)
    expect(hub.calls.find((c) => c.path === 'clusterUpdate.startClusterUpdate')).toMatchObject({
      method: 'POST',
      input: { backup: false },
    })
    expect(lines.some((l) => l.includes('succeeded'))).toBe(true)
  })

  it('exits 1 naming the capless agent', async () => {
    const { hub, lines, deps } = harness([
      job(
        'failed',
        [
          step('backup', 'ok'),
          step('agent-server', 'failed', {
            nodeId: 'a1',
            reason: 'node-capless',
            detail: 'a1 registered no capabilities',
          }),
        ],
        { stoppedAt: 'a1', reason: 'node-capless' },
      ),
    ])
    const code = await clusterUpdateCommand(await clientOf(hub), { yes: true }, deps)
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('Failed at a1: node-capless')
  })

  it('a declined confirmation starts nothing', async () => {
    const { hub, deps } = harness([])
    const code = await clusterUpdateCommand(
      await clientOf(hub),
      {},
      {
        ...deps,
        confirm: async () => false,
      },
    )
    expect(code).toBe(0)
    expect(hub.calls.some((c) => c.path === 'clusterUpdate.startClusterUpdate')).toBe(false)
  })
})
