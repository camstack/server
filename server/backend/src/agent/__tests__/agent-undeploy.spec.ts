import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoadedAddonEntry } from '../agent-service.js'
import { createAgentService } from '../agent-service.js'
import {
  type AgentRunnerRow,
  type AgentUndeploySeam,
  undeployFromAgent,
} from '../agent-undeploy.js'

const silent: IScopedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

interface ManifestEntry {
  readonly id: string
  readonly capabilities?: readonly string[]
  readonly protected?: boolean
}

function writePackage(addonsDir: string, name: string, addons: readonly ManifestEntry[]): string {
  const dir = path.join(addonsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', camstack: { addons } }),
    'utf-8',
  )
  return dir
}

interface FakeSeam extends AgentUndeploySeam {
  readonly stopped: string[]
  readonly unregistered: string[]
  readonly respawn: ReturnType<typeof vi.fn>
  readonly reconcile: ReturnType<typeof vi.fn>
}

function fakeSeam(
  addonsDir: string,
  loadedAddons: Map<string, LoadedAddonEntry>,
  runners: readonly AgentRunnerRow[],
): FakeSeam {
  const stopped: string[] = []
  const unregistered: string[] = []
  const respawn = vi.fn(async () => [])
  const reconcile = vi.fn()
  return {
    addonsDir,
    loadedAddons,
    bootstrapPackages: new Set(['@camstack/system', '@camstack/addon-pipeline']),
    listRunnersByAddon: async (addonId) => runners.filter((r) => r.addonIds.includes(addonId)),
    stopRunner: async (name) => {
      stopped.push(name)
      return { success: true }
    },
    destroyService: async () => undefined,
    unregisterProvider: (cap, addonId) => {
      unregistered.push(`${cap}@${addonId}`)
    },
    respawnSurvivors: respawn,
    reconcileNodeRegistration: reconcile,
    logger: silent,
    stopped,
    unregistered,
    respawn,
    reconcile,
  }
}

describe('undeployFromAgent', () => {
  let addonsDir: string

  beforeEach(() => {
    addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undeploy-'))
  })

  afterEach(() => {
    fs.rmSync(addonsDir, { recursive: true, force: true })
  })

  it('stops the runner hosting a package addon, drops its caps, row and folder (the 2026-10-08 leak)', async () => {
    const dir = writePackage(addonsDir, '@camstack/addon-decoder-ffmpeg', [
      { id: 'decoder-ffmpeg', capabilities: ['decoder'] },
    ])
    const loaded = new Map<string, LoadedAddonEntry>([
      [
        'decoder-ffmpeg',
        { id: 'decoder-ffmpeg', status: 'running', packageName: '@camstack/addon-decoder-ffmpeg' },
      ],
    ])
    const seam = fakeSeam(addonsDir, loaded, [
      { name: 'decoder-ffmpeg', addonIds: ['decoder-ffmpeg'] },
    ])

    const result = await undeployFromAgent(seam, {
      packageName: '@camstack/addon-decoder-ffmpeg',
      addonId: 'decoder-ffmpeg',
    })

    expect(result.outcome).toBe('uninstalled')
    expect(result.scope).toBe('package')
    expect(seam.stopped).toEqual(['decoder-ffmpeg'])
    expect(seam.unregistered).toEqual(['decoder@decoder-ffmpeg'])
    expect(loaded.has('decoder-ffmpeg')).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
    expect(seam.respawn).not.toHaveBeenCalled()
    expect(seam.reconcile).toHaveBeenCalledOnce()
  })

  it('finds a package whose addons never loaded (copy on disk, nothing in loadedAddons)', async () => {
    const dir = writePackage(addonsDir, '@camstack/addon-x', [{ id: 'x' }])
    const seam = fakeSeam(addonsDir, new Map(), [])

    const result = await undeployFromAgent(seam, { packageName: '@camstack/addon-x' })

    expect(result.outcome).toBe('uninstalled')
    expect(result.addonIds).toEqual(['x'])
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('respawns survivors of a shared runner without the removed addon', async () => {
    writePackage(addonsDir, '@camstack/addon-a', [{ id: 'a', capabilities: ['cap-a'] }])
    writePackage(addonsDir, '@camstack/addon-b', [{ id: 'b', capabilities: ['cap-b'] }])
    const loaded = new Map<string, LoadedAddonEntry>([
      ['a', { id: 'a', status: 'running', packageName: '@camstack/addon-a' }],
      ['b', { id: 'b', status: 'running', packageName: '@camstack/addon-b' }],
    ])
    const seam = fakeSeam(addonsDir, loaded, [{ name: 'ml', addonIds: ['a', 'b'] }])

    const result = await undeployFromAgent(seam, { packageName: '@camstack/addon-a' })

    expect(seam.stopped).toEqual(['ml'])
    // b's row is dropped so discovery re-adds it into a fresh runner.
    expect(loaded.has('b')).toBe(false)
    expect(seam.respawn).toHaveBeenCalledOnce()
    expect(result.runnersRespawned).toEqual(['ml'])
    expect(fs.existsSync(path.join(addonsDir, '@camstack/addon-b'))).toBe(true)
  })

  it('refuses bootstrap packages and touches nothing', async () => {
    const dir = writePackage(addonsDir, '@camstack/addon-pipeline', [{ id: 'pipeline-runner' }])
    const seam = fakeSeam(addonsDir, new Map(), [
      { name: 'pipeline-runner', addonIds: ['pipeline-runner'] },
    ])

    const result = await undeployFromAgent(seam, { packageName: '@camstack/addon-pipeline' })

    expect(result.outcome).toBe('refused')
    expect(result.success).toBe(false)
    expect(seam.stopped).toEqual([])
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('refuses a package whose manifest marks an addon protected', async () => {
    const dir = writePackage(addonsDir, '@camstack/addon-guarded', [
      { id: 'guarded', protected: true },
    ])
    const seam = fakeSeam(addonsDir, new Map(), [])

    const result = await undeployFromAgent(seam, { packageName: '@camstack/addon-guarded' })

    expect(result.outcome).toBe('refused')
    expect(result.reason).toContain('protected')
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('answers not-installed for a package this node does not have', async () => {
    const seam = fakeSeam(addonsDir, new Map(), [])
    const result = await undeployFromAgent(seam, { packageName: '@camstack/addon-absent' })
    expect(result.outcome).toBe('not-installed')
    expect(seam.reconcile).not.toHaveBeenCalled()
  })

  it('refuses a package name that escapes the addon root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undeploy-outside-'))
    try {
      const seam = fakeSeam(addonsDir, new Map(), [])
      const result = await undeployFromAgent(seam, {
        packageName: path.relative(addonsDir, outside),
      })
      expect(result.outcome).toBe('not-installed')
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('addon mode (the reconcile) also stops the hosting runner', async () => {
    const loaded = new Map<string, LoadedAddonEntry>([
      ['stale', { id: 'stale', status: 'running' }],
    ])
    const seam = fakeSeam(addonsDir, loaded, [{ name: 'stale', addonIds: ['stale'] }])

    const result = await undeployFromAgent(seam, { addonId: 'stale' })

    expect(result.scope).toBe('addon')
    expect(seam.stopped).toEqual(['stale'])
    expect(loaded.has('stale')).toBe(false)
  })
})

describe('$agent.undeploy wiring', () => {
  let broker: ServiceBroker | undefined
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-undeploy-svc-'))
  })

  afterEach(async () => {
    await broker?.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("calls this node's $process.stop for the runner hosting the package", async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const addonsDir = path.join(tmpDir, 'addons')
    writePackage(addonsDir, '@camstack/addon-decoder-ffmpeg', [
      { id: 'decoder-ffmpeg', capabilities: ['decoder'] },
    ])
    const loadedAddons = new Map<string, LoadedAddonEntry>([
      [
        'decoder-ffmpeg',
        { id: 'decoder-ffmpeg', status: 'running', packageName: '@camstack/addon-decoder-ffmpeg' },
      ],
    ])
    const stops: string[] = []
    broker.createService({
      name: '$process',
      actions: {
        listByAddon: (ctx: { params: { addonId: string } }) =>
          ctx.params.addonId === 'decoder-ffmpeg'
            ? [{ name: 'decoder-ffmpeg', addonIds: ['decoder-ffmpeg'] }]
            : [],
        stop: (ctx: { params: { name: string } }) => {
          stops.push(ctx.params.name)
          return { success: true }
        },
      },
    })
    const unregistered: string[] = []
    broker.createService(
      createAgentService({
        addonsDir,
        agentName: 'test-agent',
        configPath: path.join(tmpDir, 'agent.json'),
        dataDir: tmpDir,
        loadedAddons,
        unregisterProvider: (cap, id) => unregistered.push(`${cap}@${id}`),
      }),
    )
    await broker.start()

    const result = (await broker.call('$agent.undeploy', {
      packageName: '@camstack/addon-decoder-ffmpeg',
      addonId: 'decoder-ffmpeg',
    })) as Record<string, unknown>

    expect(result['outcome']).toBe('uninstalled')
    expect(stops).toEqual(['decoder-ffmpeg'])
    expect(unregistered).toEqual(['decoder@decoder-ffmpeg'])
    expect(fs.existsSync(path.join(addonsDir, '@camstack/addon-decoder-ffmpeg'))).toBe(false)
  })
})
