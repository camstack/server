import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LoadedAddonEntry } from '../agent-service.js'
import { createAgentService } from '../agent-service.js'

describe('$agent service', () => {
  let broker: ServiceBroker
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'))
  })

  afterEach(async () => {
    if (broker) await broker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports status with system info', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons: new Map(),
    })
    broker.createService(schema)
    await broker.start()

    const status = (await broker.call('$agent.status')) as Record<string, unknown>
    expect(status.nodeId).toBe('agent-test')
    expect(status.platform).toBe(os.platform())
    expect(status.cpuCores).toBe(os.cpus().length)
    expect(status.addons).toEqual([])
  })

  it('lists installed addons', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const loadedAddons = new Map<string, LoadedAddonEntry>([
      ['my-addon', { id: 'my-addon', status: 'running' }],
    ])
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons,
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.listAddons')) as readonly string[]
    expect(result).toEqual(['my-addon'])
  })

  it('undeploy removes addon from loaded map', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const loadedAddons = new Map<string, LoadedAddonEntry>([
      ['my-addon', { id: 'my-addon', status: 'running' }],
    ])
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons,
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.undeploy', { addonId: 'my-addon' })) as Record<
      string,
      unknown
    >
    expect(result.success).toBe(true)
    expect(loadedAddons.has('my-addon')).toBe(false)
  })

  it('undeploy does NOT remove a package dir still shared by other loaded addons', async () => {
    // Regression: `@camstack/addon-pipeline` ships many addons (decoder-ffmpeg,
    // recorder, motion-wasm, …) from ONE package dir. Undeploying a single
    // member (e.g. a version-skew `decoder-nodeav` the hub does not know) must
    // NOT rmSync the whole shared bundle — that wipes every sibling runner,
    // which then crash-loops on the missing package.json.
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const addonsDir = path.join(tmpDir, 'addons')
    const pkgDir = path.join(addonsDir, '@camstack/addon-pipeline')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}', 'utf-8')

    const loadedAddons = new Map<string, LoadedAddonEntry>([
      [
        'decoder-nodeav',
        { id: 'decoder-nodeav', status: 'running', packageName: '@camstack/addon-pipeline' },
      ],
      [
        'decoder-ffmpeg',
        { id: 'decoder-ffmpeg', status: 'running', packageName: '@camstack/addon-pipeline' },
      ],
    ])
    const schema = createAgentService({
      addonsDir,
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons,
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.undeploy', { addonId: 'decoder-nodeav' })) as Record<
      string,
      unknown
    >
    expect(result.success).toBe(true)
    expect(loadedAddons.has('decoder-nodeav')).toBe(false)
    // The sibling still owns the package dir — it must survive.
    expect(fs.existsSync(pkgDir)).toBe(true)
  })

  it('undeploy removes the package dir when no other loaded addon shares it', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const addonsDir = path.join(tmpDir, 'addons')
    const pkgDir = path.join(addonsDir, '@camstack/addon-pipeline')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}', 'utf-8')

    const loadedAddons = new Map<string, LoadedAddonEntry>([
      [
        'decoder-nodeav',
        { id: 'decoder-nodeav', status: 'running', packageName: '@camstack/addon-pipeline' },
      ],
    ])
    const schema = createAgentService({
      addonsDir,
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons,
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.undeploy', { addonId: 'decoder-nodeav' })) as Record<
      string,
      unknown
    >
    expect(result.success).toBe(true)
    expect(fs.existsSync(pkgDir)).toBe(false)
  })

  it('health reports addon counts and core fields', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const loadedAddons = new Map<string, LoadedAddonEntry>([
      ['addon-a', { id: 'addon-a', status: 'running' }],
      ['addon-b', { id: 'addon-b', status: 'running' }],
      ['addon-c', { id: 'addon-c', status: 'error' }],
    ])
    const configFile = path.join(tmpDir, 'agent.json')
    fs.writeFileSync(configFile, JSON.stringify({ hubAddress: '10.0.0.1:6000' }), 'utf-8')

    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'health-bot',
      configPath: configFile,
      dataDir: tmpDir,
      loadedAddons,
      agentVersion: '1.2.3',
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.health')) as Record<string, unknown>
    expect(result.ok).toBe(false) // one addon errored
    expect(result.nodeId).toBe('agent-test')
    expect(result.name).toBe('health-bot')
    expect(result.version).toBe('1.2.3')
    expect(result.pid).toBe(process.pid)
    expect(result.hubAddress).toBe('10.0.0.1:6000')
    expect(result.hubConnected).toBe(false) // no hub connected in test
    expect(result.addons).toEqual({ total: 3, running: 2, error: 1 })
    expect(typeof result.uptimeSeconds).toBe('number')
    expect(typeof result.checkedAt).toBe('string')
  })

  it('health ok=true when all addons running', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const loadedAddons = new Map<string, LoadedAddonEntry>([
      ['addon-a', { id: 'addon-a', status: 'running' }],
    ])
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'green',
      configPath: path.join(tmpDir, 'agent.json'),
      dataDir: tmpDir,
      loadedAddons,
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.health')) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.addons).toEqual({ total: 1, running: 1, error: 0 })
    expect(result.hubAddress).toBeNull()
  })

  it('restart delegates to the agent-local $process.restart for the addon runner', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    // Fake the agent's own `$process` service — the real one (createProcessService)
    // is registered on the agent broker in agent-bootstrap. `$agent.restart` must
    // route to it so the runner hosting the addon is actually respawned + its crash
    // streak reset, instead of the old no-op `restart-queued` stub.
    const restartCalls: { name: unknown }[] = []
    broker.createService({
      name: '$process',
      actions: {
        restart: {
          handler(ctx: { params: { name: unknown } }): { success: boolean; pid: number } {
            restartCalls.push({ name: ctx.params.name })
            return { success: true, pid: 4242 }
          },
        },
      },
    })
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons: new Map(),
    })
    broker.createService(schema)
    await broker.start()

    const result = (await broker.call('$agent.restart', { addonId: 'my-addon' })) as Record<
      string,
      unknown
    >
    // Delegated to $process.restart, keyed by the addon id (resolveRunnerName
    // maps it to its hosting runner) — not the old fire-and-forget stub.
    expect(restartCalls).toEqual([{ name: 'my-addon' }])
    expect(result.success).toBe(true)
    expect(result.addonId).toBe('my-addon')
    expect(result.pid).toBe(4242)
    // The old no-op contract is gone.
    expect(result.action).toBeUndefined()
  })

  it('restart fails loudly when the runner cannot be restarted', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    broker.createService({
      name: '$process',
      actions: {
        restart: {
          handler(): { success: boolean; reason: string } {
            return { success: false, reason: 'not found' }
          },
        },
      },
    })
    const schema = createAgentService({
      addonsDir: path.join(tmpDir, 'addons'),
      agentName: 'test-agent',
      configPath: '/tmp/test-agent.json',
      dataDir: tmpDir,
      loadedAddons: new Map(),
    })
    broker.createService(schema)
    await broker.start()

    await expect(broker.call('$agent.restart', { addonId: 'ghost-addon' })).rejects.toThrow(
      /process restart failed for "ghost-addon": not found/,
    )
  })

  it('a name persisted to agent.json shows in $agent.status even when the in-memory rename never ran', async () => {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    const configPath = path.join(tmpDir, 'agent.json')
    broker.createService(
      createAgentService({
        addonsDir: path.join(tmpDir, 'addons'),
        agentName: 'old-name',
        configPath,
        dataDir: tmpDir,
        loadedAddons: new Map(),
      }),
    )
    await broker.start()
    // The agent UI writes the file first and calls `$agent.rename` best-effort; when that call
    // is lost (broker mid-reconnect while pairing) only the file carries the new name.
    fs.writeFileSync(configPath, JSON.stringify({ name: 'mac-mini' }), 'utf-8')
    const status = (await broker.call('$agent.status')) as Record<string, unknown>
    expect(status.name).toBe('mac-mini')
  })
})
