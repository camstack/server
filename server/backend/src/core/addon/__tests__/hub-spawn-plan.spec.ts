/**
 * The hub spawns only addons the stale gate passes (planning#447), on EVERY
 * path that brings a runner up — the boot plan, a restart, a hot-install —
 * reading the real addons directory and the real package.json files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonDeclaration,
  type CapabilityDeclaration,
  type IScopedLogger,
} from '@camstack/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CapabilityService } from '../../capability/capability.service'
import { ConfigService } from '../../config/config.service'
import { EventBusService } from '../../events/event-bus.service'
import { LoggingService } from '../../logging/logging.service'
import { MoleculerService } from '../../moleculer/moleculer.service'
import { StorageService } from '../../storage/storage.service'
import { StreamProbeService } from '../../streaming/stream-probe.service'
import { AddonRegistryService } from '../addon-registry.service.js'

/** A class instance with only the members the spec sets: no constructor, no cast. */
function stubOf<T extends object>(ctor: { readonly prototype: T }, members: object): T {
  const instance: T = Object.create(ctor.prototype)
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(instance, key, { value, writable: true, configurable: true })
  }
  return instance
}

const GROUP = 'g'
const FAR_FUTURE_SERVER = '>=9999.0.0'

interface Fixture {
  readonly id: string
  readonly pkg: string
  readonly version: string
  /** The package.json body; a string is written verbatim (malformed on purpose). */
  readonly packageJson: Readonly<Record<string, unknown>> | string
  readonly capabilities: readonly CapabilityDeclaration[]
}

const FIXTURES: readonly Fixture[] = [
  {
    id: 'old',
    pkg: '@camstack/addon-old',
    version: '1.0.0',
    packageJson: { camstack: { requires: { server: FAR_FUTURE_SERVER } } },
    capabilities: [],
  },
  {
    id: 'fresh',
    pkg: '@camstack/addon-fresh',
    version: '3.0.0',
    packageJson: {},
    capabilities: [],
  },
  {
    id: 'broken',
    pkg: '@camstack/addon-broken',
    version: '1.0.0',
    packageJson: '{ not json',
    capabilities: [],
  },
  {
    id: 'store',
    pkg: '@camstack/addon-store',
    version: '1.0.0',
    packageJson: { camstack: { requires: { server: FAR_FUTURE_SERVER } } },
    capabilities: [{ name: 'data-store-provider' }],
  },
]

let addonsRoot = ''
let previousAddonsDir: string | undefined

beforeAll(() => {
  addonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-spawn-plan-'))
  previousAddonsDir = process.env.CAMSTACK_ADDONS_DIR
  process.env.CAMSTACK_ADDONS_DIR = addonsRoot
  for (const f of FIXTURES) {
    const dir = path.join(addonsRoot, f.pkg)
    fs.mkdirSync(dir, { recursive: true })
    const body =
      typeof f.packageJson === 'string'
        ? f.packageJson
        : JSON.stringify({ name: f.pkg, version: f.version, ...f.packageJson })
    fs.writeFileSync(path.join(dir, 'package.json'), body)
  }
})

afterAll(() => {
  if (previousAddonsDir === undefined) delete process.env.CAMSTACK_ADDONS_DIR
  else process.env.CAMSTACK_ADDONS_DIR = previousAddonsDir
  fs.rmSync(addonsRoot, { recursive: true, force: true })
})

function build(): {
  readonly registry: AddonRegistryService
  readonly warn: ReturnType<typeof vi.fn>
  readonly calls: { readonly action: string; readonly params: unknown }[]
} {
  const warn = vi.fn()
  const sink: IScopedLogger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => sink,
    withTags: () => sink,
  }
  const calls: { action: string; params: unknown }[] = []
  const broker = {
    nodeID: 'hub',
    call: async (action: string, params: unknown): Promise<unknown> => {
      calls.push({ action, params })
      if (action === '$process.list') return []
      if (action === '$process.spawnRunner') return { pid: 4242 }
      throw new Error(`unexpected broker action ${action}`)
    },
  }
  const registry = new AddonRegistryService(
    stubOf(LoggingService, { createLogger: () => sink }),
    stubOf(EventBusService, { emit: () => undefined, subscribe: () => () => undefined }),
    stubOf(ConfigService, { get: () => undefined }),
    stubOf(StorageService, {}),
    stubOf(CapabilityService, { setRegistry: () => undefined }),
    stubOf(MoleculerService, {
      broker,
      childRegistry: {},
      setRunnerIdResolver: () => undefined,
    }),
    stubOf(StreamProbeService, {}),
  )
  const entries: Map<string, unknown> = Reflect.get(registry, 'addonEntries')
  for (const f of FIXTURES) {
    const declaration: AddonDeclaration = { id: f.id, name: f.id, execution: { group: GROUP } }
    entries.set(f.id, {
      addon: { manifest: { id: f.id, name: f.id } },
      initialized: true,
      source: 'installed',
      packageName: f.pkg,
      packageVersion: f.version,
      declaredCapabilities: f.capabilities,
      addonDir: path.join(addonsRoot, f.pkg),
      declaration,
    })
  }
  return { registry, warn, calls }
}

describe('the hub spawn gate reads the real package files', () => {
  it('leaves out an addon needing a newer server and one whose package.json is unreadable', () => {
    const { registry, warn } = build()
    const plan = registry.buildSpawnPlan(['old', 'fresh', 'broken'])
    expect([...(plan.get(GROUP)?.map((a) => a.addonId) ?? [])]).toEqual(['fresh'])
    const lines = warn.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('addon-old') && l.includes('9999.0.0'))).toBe(true)
    expect(lines.some((l) => l.includes('addon-broken') && l.includes('could not be read'))).toBe(
      true,
    )
  })

  it('still spawns a stale infrastructure provider, and says so loudly', () => {
    const { registry, warn } = build()
    const plan = registry.buildSpawnPlan(['store'])
    expect([...(plan.get(GROUP)?.map((a) => a.addonId) ?? [])]).toEqual(['store'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('SPAWNED ANYWAY'))).toBe(true)
  })
})

describe('ensureForkedRunner uses the same gate (restart, hot-install, retry)', () => {
  it('refuses to spawn a held-back addon and names the versions', async () => {
    const { registry, calls } = build()
    const ensure = (id: string) =>
      Reflect.apply(Reflect.get(registry, 'ensureForkedRunner'), registry, [id, { restart: false }])
    await expect(ensure('old')).rejects.toThrow(/held back.*9999\.0\.0/)
    expect(calls.filter((c) => c.action === '$process.spawnRunner')).toEqual([])
  })

  it('leaves held-back siblings (not infrastructure) out of the roster it spawns', async () => {
    const { registry, calls } = build()
    await Reflect.apply(Reflect.get(registry, 'ensureForkedRunner'), registry, [
      'fresh',
      { restart: false },
    ])
    const spawn = calls.find((c) => c.action === '$process.spawnRunner')
    const roster: unknown = spawn === undefined ? null : Reflect.get(Object(spawn.params), 'addons')
    expect(Array.isArray(roster) ? roster.map((r) => Reflect.get(r, 'addonId')) : roster).toEqual([
      'fresh',
      'store',
    ])
  })
})
