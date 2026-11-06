/**
 * The hub spawns EVERY addon, below its minimum or not (D1017), on every path
 * that brings a runner up - the boot plan, a restart, a hot-install - reading the
 * real addons directory and the real package.json files. An addon below the
 * minimum raises the unsupported-version alert once, and clears it when its
 * package is updated.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonDeclaration,
  type CapabilityDeclaration,
  type IScopedLogger,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNSUPPORTED_ADDON_SETTLE_MS } from '@camstack/server/system'
import {
  evaluateRunnerBootCheck,
  isRunnerBootCheckDegraded,
} from '../../runner-health/runner-boot-check.js'
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

interface Emitted {
  readonly category: string
  readonly data: Record<string, unknown>
}

function build(): {
  readonly registry: AddonRegistryService
  readonly emitted: Emitted[]
  readonly calls: { readonly action: string; readonly params: unknown }[]
} {
  const sink: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => sink,
    withTags: () => sink,
  }
  const emitted: Emitted[] = []
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
    stubOf(EventBusService, {
      emit: (e: Emitted) => void emitted.push({ category: e.category, data: e.data }),
      subscribe: () => () => undefined,
    }),
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
  return { registry, emitted, calls }
}

const rosterOf = (plan: ReturnType<AddonRegistryService['buildSpawnPlan']>): readonly string[] =>
  (plan.get(GROUP) ?? []).map((a) => a.addonId)

const unsupportedOf = (emitted: readonly Emitted[]): readonly Emitted[] =>
  emitted.filter((e) => e.category === EventCategory.AddonUnsupportedVersion)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the hub spawns every addon and alerts for the unsupported ones', () => {
  it('spawns an addon needing a newer server, an unreadable package and an infra provider alike', () => {
    const { registry } = build()
    const plan = registry.buildSpawnPlan(['old', 'fresh', 'broken', 'store'])
    expect([...rosterOf(plan)].sort()).toEqual(['broken', 'fresh', 'old', 'store'])
  })

  it('raises ONE alert per unsupported addon, infra and non-infra alike, with the versions; none for an unreadable package', () => {
    const { registry, emitted } = build()
    registry.buildSpawnPlan(['old', 'fresh', 'broken', 'store'])
    registry.buildSpawnPlan(['old', 'fresh', 'broken', 'store'])
    vi.advanceTimersByTime(UNSUPPORTED_ADDON_SETTLE_MS)
    const raised = unsupportedOf(emitted)
    expect(raised.map((e) => e.data['addonId']).sort()).toEqual(['old', 'store'])
    const old = raised.find((e) => e.data['addonId'] === 'old')
    expect(old?.data).toMatchObject({
      packageName: '@camstack/addon-old',
      installedVersion: '1.0.0',
      nodeId: 'hub',
    })
    expect(String(old?.data['unmet'])).toContain('9999.0.0')
  })

  it('emits the recovery once the package on disk is supported, and the alert is not raised again', () => {
    const { registry, emitted } = build()
    registry.buildSpawnPlan(['old'])
    vi.advanceTimersByTime(UNSUPPORTED_ADDON_SETTLE_MS)
    const file = path.join(addonsRoot, '@camstack/addon-old', 'package.json')
    const before = fs.readFileSync(file, 'utf-8')
    try {
      fs.writeFileSync(file, JSON.stringify({ name: '@camstack/addon-old', version: '2.0.0' }))
      registry.buildSpawnPlan(['old'])
      registry.buildSpawnPlan(['old'])
    } finally {
      fs.writeFileSync(file, before)
    }
    const alerts = emitted.filter((e) => e.category.startsWith('addon.unsupported-'))
    expect(alerts.map((e) => e.category)).toEqual([
      EventCategory.AddonUnsupportedVersion,
      EventCategory.AddonUnsupportedResolved,
    ])
    expect(alerts[1]?.data).toMatchObject({ packageName: '@camstack/addon-old', nodeId: 'hub' })
  })

  it('a runner that hosts an unsupported addon counts as running in the boot check, not as failed', () => {
    const { registry } = build()
    registry.buildSpawnPlan(['old', 'fresh'])
    const check = evaluateRunnerBootCheck({
      planned: registry.plannedRunnerIds(),
      processes: [{ name: GROUP, addonIds: ['old', 'fresh', 'broken', 'store'], state: 'running' }],
      now: 0,
    })
    expect(check.failed).toEqual([])
    expect(check.running).toBe(1)
    expect(isRunnerBootCheckDegraded(check)).toBe(false)
  })
})

describe('ensureForkedRunner spawns an unsupported addon (restart, hot-install, retry)', () => {
  it('spawns the runner of an addon below the minimum, with it in the roster', async () => {
    const { registry, calls } = build()
    await Reflect.apply(Reflect.get(registry, 'ensureForkedRunner'), registry, [
      'old',
      { restart: false },
    ])
    const spawn = calls.find((c) => c.action === '$process.spawnRunner')
    const roster: unknown = spawn === undefined ? null : Reflect.get(Object(spawn.params), 'addons')
    expect(
      Array.isArray(roster) ? roster.map((r) => Reflect.get(r, 'addonId')).sort() : roster,
    ).toEqual(['broken', 'fresh', 'old', 'store'])
  })
})
