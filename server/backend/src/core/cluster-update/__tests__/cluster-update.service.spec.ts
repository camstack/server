import type {
  BackupRun,
  BackupTriggerResult,
  ClusterUpdateJob,
  IScopedLogger,
  ServerPackageStatus,
  ServerUpdateActionResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ClusterUpdateService } from '../cluster-update.service.js'
import type {
  ClusterAddonUpdate,
  ClusterAddonUpdateResult,
  ClusterBackupClient,
  ClusterInstallation,
  ClusterNodeView,
  ClusterUpdateJobStore,
  ClusterUpdateSeams,
} from '../cluster-update-seams.js'

const TARGET = '2.0.0'

function logger(): IScopedLogger {
  const instance: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => instance,
    withTags: () => instance,
  }
  return instance
}

function status(running: string, over: Partial<ServerPackageStatus> = {}): ServerPackageStatus {
  return {
    packageName: '@camstack/server',
    runningVersion: running,
    nodeRuntimeVersion: '24.0.0',
    activeVersion: running,
    previousVersion: null,
    seedVersion: null,
    latestVersion: TARGET,
    updateAvailable: running !== TARGET,
    bootMode: 'data-root',
    updateState: 'idle',
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: 1,
    restartRequired: false,
    ...over,
  }
}

function staged(): ServerUpdateActionResult {
  return {
    accepted: true,
    targetVersion: TARGET,
    restarting: true,
    message: 'staged',
    outcome: 'staged',
  }
}

class MemoryStore implements ClusterUpdateJobStore {
  job: ClusterUpdateJob | null = null
  load = (): ClusterUpdateJob | null => this.job
  save = (job: ClusterUpdateJob): void => {
    this.job = job
  }
}

interface World {
  versions: Map<string, string>
  nodes: ClusterNodeView[]
  calls: string[]
  /** What `applyServerUpdate` does per node; default: stage and switch to the target. */
  apply: (nodeId: string) => Promise<ServerUpdateActionResult>
  /** The caps a node registers once it runs the target (default 3). */
  capsAfter: Map<string, number>
  backup: ClusterBackupClient | null
  addonUpdates: ClusterAddonUpdate[]
  updateAddon: (name: string, version: string) => Promise<ClusterAddonUpdateResult>
  installs: ClusterInstallation[]
}

function world(): World {
  const w: World = {
    versions: new Map([
      ['hub', '1.0.0'],
      ['agent-a', '1.0.0'],
      ['agent-b', '1.0.0'],
    ]),
    nodes: [
      { id: 'hub', isHub: true, isOnline: true, capabilityCount: 10 },
      {
        id: 'agent-a',
        isHub: false,
        isOnline: true,
        capabilitiesRegistered: true,
        capabilityCount: 3,
      },
      {
        id: 'agent-b',
        isHub: false,
        isOnline: true,
        capabilitiesRegistered: true,
        capabilityCount: 3,
      },
      { id: 'agent-off', isHub: false, isOnline: false, capabilityCount: 0 },
    ],
    calls: [],
    apply: async (nodeId) => {
      w.versions.set(nodeId, TARGET)
      const caps = w.capsAfter.get(nodeId) ?? 3
      w.nodes = w.nodes.map((n) =>
        n.id === nodeId && !n.isHub
          ? { ...n, capabilitiesRegistered: caps > 0, capabilityCount: caps }
          : n,
      )
      return staged()
    },
    capsAfter: new Map(),
    backup: {
      trigger: async (label): Promise<BackupTriggerResult> => {
        w.calls.push(`backup:${label}`)
        return {
          runId: 'run-1',
          queued: false,
          joined: false,
          cancelled: false,
          entries: [{ id: 'b1', destinationId: 'd1', createdAt: 1, sizeBytes: 1 }],
        }
      },
      listRuns: async (): Promise<readonly BackupRun[]> => [],
    },
    addonUpdates: [
      {
        name: '@camstack/addon-x',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
      },
    ],
    updateAddon: async (name, version) => {
      w.calls.push(`addon:${name}@${version}`)
      w.installs = w.installs.map((r) => (r.packageName === name ? { ...r, version } : r))
      return { success: true }
    },
    installs: [
      {
        packageName: '@camstack/addon-x',
        nodeId: 'hub',
        isHub: true,
        isOnline: true,
        version: '1.0.0',
      },
      {
        packageName: '@camstack/addon-x',
        nodeId: 'agent-a',
        isHub: false,
        isOnline: true,
        version: '1.0.0',
      },
    ],
  }
  return w
}

let ids = 0
function seams(w: World, store: ClusterUpdateJobStore): ClusterUpdateSeams {
  let clock = 1_000_000
  return {
    readTopology: async () => w.nodes,
    readServerStatus: async (nodeId) => status(w.versions.get(nodeId ?? 'hub') ?? 'unknown'),
    applyServerUpdate: async (nodeId, version) => {
      w.calls.push(`apply:${nodeId ?? 'hub'}@${version}`)
      return w.apply(nodeId ?? 'hub')
    },
    getBackup: () => w.backup,
    listAddonUpdates: async () =>
      w.addonUpdates.filter((u) =>
        w.installs.some(
          (r) => r.isHub && r.packageName === u.name && r.version !== u.latestVersion,
        ),
      ),
    updateAddon: (name, version) => w.updateAddon(name, version),
    readInstallations: async () => w.installs,
    store,
    logger: logger(),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    newId: () => `job-${(ids += 1)}`,
    timeouts: { serverMs: 60_000, addonsMs: 60_000, pollMs: 5_000 },
  }
}

async function run(w: World, store = new MemoryStore()): Promise<ClusterUpdateJob> {
  const service = new ClusterUpdateService(seams(w, store))
  const started = await service.start({}, 'admin')
  expect(started.accepted).toBe(true)
  await service.idle()
  const job = service.getJob(started.jobId ?? undefined)
  if (job === null) throw new Error('job missing')
  return job
}

describe('ClusterUpdateService', () => {
  it('runs backup, hub, each online agent, then addons, each verified', async () => {
    const w = world()
    const job = await run(w)
    expect(job.state).toBe('succeeded')
    expect(w.calls).toEqual([
      `backup:cluster-update ${job.id}`,
      'apply:hub@2.0.0',
      'apply:agent-a@2.0.0',
      'apply:agent-b@2.0.0',
      'addon:@camstack/addon-x@1.1.0',
    ])
    expect(job.steps.map((s) => `${s.kind}:${s.nodeId ?? ''}:${s.status}`)).toEqual([
      'backup::ok',
      'hub-server:hub:ok',
      'agent-server:agent-a:ok',
      'agent-server:agent-b:ok',
      'addons::ok',
    ])
    expect(job.skippedOffline).toEqual(['agent-off'])
  })

  it('an agent that comes back on the target with NO capabilities fails the job (1.2.826)', async () => {
    const w = world()
    w.capsAfter.set('agent-a', 0)
    const job = await run(w)
    expect(job.state).toBe('failed')
    expect(job.stoppedAt).toBe('agent-a')
    expect(job.reason).toBe('node-capless')
    expect(job.steps.find((s) => s.nodeId === 'agent-b')?.status).toBe('skipped')
    expect(job.steps.find((s) => s.kind === 'addons')?.status).toBe('skipped')
    expect(w.calls).not.toContain('apply:agent-b@2.0.0')
  })

  it('a refused hub update stops the job before any agent or addon', async () => {
    const w = world()
    w.apply = async (nodeId) => {
      if (nodeId === 'hub') {
        return {
          accepted: false,
          targetVersion: TARGET,
          restarting: false,
          message: 'refused',
          outcome: 'refused',
          reason: 'addon-would-refuse',
        }
      }
      return staged()
    }
    const job = await run(w)
    expect(job.state).toBe('failed')
    expect(job.reason).toBe('server-refused')
    expect(w.calls.filter((c) => c.startsWith('apply:'))).toEqual(['apply:hub@2.0.0'])
    expect(w.calls.some((c) => c.startsWith('addon:'))).toBe(false)
  })

  it('no backup provider is a failure before anything moves; backup:false opts out', async () => {
    const w = world()
    w.backup = null
    const job = await run(w)
    expect(job.reason).toBe('backup-unavailable')
    expect(w.calls).toEqual([])

    const w2 = world()
    w2.backup = null
    const service = new ClusterUpdateService(seams(w2, new MemoryStore()))
    const started = await service.start({ backup: false }, 'admin')
    await service.idle()
    expect(service.getJob(started.jobId ?? undefined)?.state).toBe('succeeded')
  })

  it('a backup call that drops is reconciled by its run, not by the error', async () => {
    const w = world()
    let runs: BackupRun[] = []
    w.backup = {
      trigger: async (label) => {
        runs = [
          {
            id: 'run-9',
            state: 'failed',
            phase: 'done',
            destinationIds: ['d1'],
            label,
            requestedAt: 1_000_000,
            stagedBytes: 0,
            uploadedBytes: 0,
            completedDestinationIds: [],
            failedDestinationIds: ['d1'],
            error: 'disk full',
          },
        ]
        throw new Error('Request is timed out')
      },
      listRuns: async () => runs,
    }
    const job = await run(w)
    expect(job.reason).toBe('backup-failed')
    expect(job.steps[0]?.detail).toContain('disk full')
    expect(w.calls.some((c) => c.startsWith('apply:'))).toBe(false)
  })

  it('an addon update answering success:false fails the step (it does not throw)', async () => {
    const w = world()
    w.updateAddon = async () => ({ success: false, error: 'registry 404' })
    const job = await run(w)
    expect(job.reason).toBe('addon-update-failed')
    expect(job.steps.at(-1)?.detail).toContain('registry 404')
  })

  it('agents that never converge on the hub addon version fail the addons step', async () => {
    const w = world()
    w.updateAddon = async (name, version) => {
      w.installs = w.installs.map((r) =>
        r.isHub && r.packageName === name ? { ...r, version } : r,
      )
      return { success: true }
    }
    const job = await run(w)
    expect(job.reason).toBe('addons-not-converged')
    expect(job.steps.at(-1)?.detail).toContain('agent-a/@camstack/addon-x=1.0.0')
  })

  it('resumes after the hub restart: verifies the hub then runs the agents', async () => {
    const store = new MemoryStore()
    const w = world()
    // The hub process dies under its own apply: the call never returns.
    w.apply = (nodeId) => (nodeId === 'hub' ? new Promise(() => undefined) : world().apply(nodeId))
    const first = new ClusterUpdateService(seams(w, store))
    await first.start({ addons: false }, 'admin')
    await new Promise((r) => setTimeout(r, 0))
    expect(store.job?.steps.find((s) => s.kind === 'hub-server')?.status).toBe('running')

    // New boot, on the target.
    const w2 = world()
    w2.versions.set('hub', TARGET)
    const second = new ClusterUpdateService(seams(w2, store))
    second.resume()
    await second.idle()
    expect(store.job?.state).toBe('succeeded')
    expect(w2.calls).toEqual(['apply:agent-a@2.0.0', 'apply:agent-b@2.0.0'])
  })

  it('a hub that came back on the OLD version fails the resumed job, agents untouched', async () => {
    const store = new MemoryStore()
    const w = world()
    w.apply = (nodeId) => (nodeId === 'hub' ? new Promise(() => undefined) : world().apply(nodeId))
    await new ClusterUpdateService(seams(w, store)).start({}, 'admin')
    await new Promise((r) => setTimeout(r, 0))

    const w2 = world()
    const second = new ClusterUpdateService(seams(w2, store))
    second.resume()
    await second.idle()
    expect(store.job?.state).toBe('failed')
    expect(store.job?.reason).toBe('server-not-on-target')
    expect(w2.calls).toEqual([])
  })

  it('a step other than the hub found running on a new boot is interrupted, never resumed', async () => {
    const store = new MemoryStore()
    store.job = {
      id: 'job-x',
      state: 'running',
      targetVersion: TARGET,
      requestedBy: 'admin',
      startedAt: 1,
      skippedOffline: [],
      steps: [
        { kind: 'backup', status: 'ok', detail: 'ok' },
        { kind: 'hub-server', nodeId: 'hub', status: 'ok', detail: 'ok' },
        {
          kind: 'agent-server',
          nodeId: 'agent-a',
          status: 'running',
          detail: 'updating',
        },
        { kind: 'addons', status: 'pending', detail: '' },
      ],
    }
    const w = world()
    const service = new ClusterUpdateService(seams(w, store))
    expect(service.getJob()?.state).toBe('failed')
    expect(store.job.reason).toBe('interrupted')
    expect(store.job.steps[3]?.status).toBe('skipped')
    expect(w.calls).toEqual([])
  })

  it('refuses a second job while one runs, and a cluster with nothing to do', async () => {
    const store = new MemoryStore()
    const w = world()
    w.apply = () => new Promise(() => undefined)
    const service = new ClusterUpdateService(seams(w, store))
    const first = await service.start({}, 'admin')
    const second = await service.start({}, 'admin')
    expect(second).toMatchObject({
      accepted: false,
      blocker: 'job-running',
      jobId: first.jobId,
    })

    const done = world()
    for (const id of ['hub', 'agent-a', 'agent-b']) done.versions.set(id, TARGET)
    done.addonUpdates = []
    const idle = new ClusterUpdateService(seams(done, new MemoryStore()))
    const refused = await idle.start({}, 'admin')
    expect(refused).toMatchObject({
      accepted: false,
      blocker: 'nothing-to-do',
      jobId: null,
    })
  })
})
