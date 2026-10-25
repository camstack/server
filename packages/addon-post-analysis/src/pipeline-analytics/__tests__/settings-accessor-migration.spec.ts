/**
 * Settings-API migration (P3c) — pipeline-analytics must read its two
 * addon-level store keys through the Zod-validated `this.state()`
 * durable handle instead of raw `ctx.settings.readAddonStore()`:
 *
 *  - `postProcessingNodeId` (single shared cluster gate, default `hub`)
 *  - `enabled` (global face-recognition master switch, default `true`)
 *
 * Equivalence: seeded values hydrate identically, and the corrupt /
 * absent / empty fallbacks stay exactly as today (absent ⇒ `hub`,
 * empty-string ⇒ `hub`, non-string ⇒ `hub`).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AddonContext, IScopedLogger } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeDeviceManager,
  makeFakeEventBus,
  makeFakeAddonApi,
  makePipelineBootRecords,
} from './test-helpers.js'

// ── Capturing logger ─────────────────────────────────────────────────

interface CapturedLogs {
  readonly logger: IScopedLogger
  readonly infos: string[]
  readonly warns: string[]
}

function makeCapturingLogger(): CapturedLogs {
  const infos: string[] = []
  const warns: string[] = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: (message: string) => {
      infos.push(message)
    },
    warn: (message: string) => {
      warns.push(message)
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, infos, warns }
}

// ── Boot (mirrors pipeline-analytics-e2e.spec.ts, seedable store) ────

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly logs: CapturedLogs
  readonly addonStore: Record<string, unknown>
}

async function boot(seed: Record<string, unknown> = {}): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  const api = makeFakeAddonApi({
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
  })
  const logs = makeCapturingLogger()
  const addonStore: Record<string, unknown> = { ...seed }
  const deviceStore = new Map<number, Record<string, unknown>>()

  const records = await makePipelineBootRecords()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger: logs.logger,
    records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: {
      localNodeId: 'hub',
      storage,
      devices: {
        getAll: async () => [],
        getChildren: async () => [],
      },
    } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        const existing = deviceStore.get(deviceId) ?? {}
        deviceStore.set(deviceId, { ...existing, ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {
        /* no-op */
      },
    },
    getNativeProvider: () => {
      throw new Error('no native providers in this spec')
    },
    fetchDevice: async () => {
      throw new Error('no devices in this spec')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return { addon, logs, addonStore }
}

const INERT_MARKER = 'INERT'

describe('pipeline-analytics — settings accessor migration', () => {
  let booted: BootResult | null = null
  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = null
  })

  it('postProcessingNodeId: designated elsewhere ⇒ this node goes inert (equivalence)', async () => {
    booted = await boot({ postProcessingNodeId: 'agent-x' })
    expect(booted.logs.infos.some((m) => m.includes(INERT_MARKER))).toBe(true)
  })

  it('postProcessingNodeId: absent ⇒ falls back to hub, node stays active (equivalence)', async () => {
    booted = await boot({})
    expect(booted.logs.infos.some((m) => m.includes(INERT_MARKER))).toBe(false)
  })

  it('postProcessingNodeId: empty string ⇒ falls back to hub, node stays active (equivalence)', async () => {
    booted = await boot({ postProcessingNodeId: '' })
    expect(booted.logs.infos.some((m) => m.includes(INERT_MARKER))).toBe(false)
  })

  it('postProcessingNodeId: corrupt (non-string) ⇒ same hub fallback + durable-state warning', async () => {
    booted = await boot({ postProcessingNodeId: 42 })
    // Same fallback as today: non-string ⇒ hub ⇒ node stays active.
    expect(booted.logs.infos.some((m) => m.includes(INERT_MARKER))).toBe(false)
    // The sanctioned `this.state()` handle logs the corrupt-blob warning.
    expect(booted.logs.warns.some((m) => m.includes('durable-state'))).toBe(true)
  })

  it('resolveGlobalFaceEnabled reads via the durable handle, not raw readAddonStore (structural)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../index.ts'), 'utf8')
    const start = source.indexOf('private async resolveGlobalFaceEnabled(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\n  }', start))
    expect(body).not.toMatch(/readAddonStore/)
    expect(body).toMatch(/faceGlobalEnabledState/)
  })
})
