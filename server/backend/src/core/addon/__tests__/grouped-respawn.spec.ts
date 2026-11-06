/**
 * Two members of one `execution.group` updated seconds apart.
 *
 * Prod 2026-11-04: provider-homeassistant respawned the `integrations` runner,
 * then export-google swapped 7s later. The hub logged `Addon restarted — v…`
 * and `Addon(s) restarted after update` while the same pid kept running the
 * previous export-google — a 10s coalesce treated the second swap as redundant.
 * A respawn satisfies a request only when it starts after that request (the
 * swap is already on disk). An in-flight fork does not.
 */
import type { AddonDeclaration, IScopedLogger, LogExtras } from '@camstack/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AddonRegistryService } from '../addon-registry.service.js'

const GROUP = 'integrations'
const HA = 'provider-homeassistant'
const GOOGLE = 'export-google'
// Versions sit far above the server's `requires.addons` minimums (which every publish train raises),
// so the hub spawn gate never holds a member back and the roster stays the whole group.

interface LoadedProcess {
  pid: number
  readonly name: string
  readonly addonIds: readonly string[]
  loaded: Readonly<Record<string, string>>
}

type InfoMock = ReturnType<typeof vi.fn<(message: string, extras?: LogExtras) => void>>

function logger(): { readonly sink: IScopedLogger; readonly info: InfoMock } {
  const info: InfoMock = vi.fn<(message: string, extras?: LogExtras) => void>()
  const sink: IScopedLogger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => sink,
    withTags: () => sink,
  }
  return { sink, info }
}

function declaration(id: string): AddonDeclaration {
  return { id, name: id, execution: { group: GROUP } } as AddonDeclaration
}

function harness(): {
  readonly registry: AddonRegistryService
  readonly disk: Record<string, string>
  readonly info: InfoMock
  process: LoadedProcess
  holdNextRestart: boolean
  releaseRestart: (() => void) | null
  readonly restarts: number
} {
  const disk: Record<string, string> = {
    [HA]: '99.2.700',
    [GOOGLE]: '99.1.125',
  }
  const state: {
    process: LoadedProcess
    holdNextRestart: boolean
    releaseRestart: (() => void) | null
    restarts: number
  } = {
    process: {
      pid: 1948,
      name: GROUP,
      addonIds: [HA, GOOGLE],
      loaded: { ...disk },
    },
    holdNextRestart: false,
    releaseRestart: null,
    restarts: 0,
  }

  const call = async (action: string): Promise<unknown> => {
    if (action === '$process.list') {
      return [
        {
          name: state.process.name,
          addonIds: state.process.addonIds,
          pid: state.process.pid,
        },
      ]
    }
    if (action === '$process.restart') {
      // The child reads disk when the fork starts, not when it finishes.
      const loaded = { ...disk }
      state.restarts += 1
      if (state.holdNextRestart) {
        state.holdNextRestart = false
        await new Promise<void>((resolve) => {
          state.releaseRestart = resolve
        })
      }
      state.process = {
        pid: state.process.pid + 1,
        name: GROUP,
        addonIds: [HA, GOOGLE],
        loaded,
      }
      return { success: true, pid: state.process.pid }
    }
    throw new Error(`unexpected broker action ${action}`)
  }

  const { sink, info } = logger()
  const loggingService = { createLogger: () => sink }
  const registry = new AddonRegistryService(
    loggingService as never,
    { emit: () => undefined, subscribe: () => () => undefined } as never,
    { get: () => undefined } as never,
    {} as never,
    { setRegistry: () => undefined } as never,
    {
      broker: { call, nodeID: 'hub' },
      childRegistry: {},
      setRunnerIdResolver: () => undefined,
    } as never,
    {} as never,
  )
  const entries = Reflect.get(registry, 'addonEntries') as Map<string, Record<string, unknown>>
  // The hub's spawn gate reads each addon's package.json, so the addons have a real one.
  const addonsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grouped-respawn-'))
  process.env.CAMSTACK_ADDONS_DIR = addonsRoot
  for (const [id, pkg, version] of [
    [HA, '@camstack/addon-provider-homeassistant', disk[HA]],
    [GOOGLE, '@camstack/addon-export-google', disk[GOOGLE]],
  ] as const) {
    const addonDir = path.join(addonsRoot, pkg)
    fs.mkdirSync(addonDir, { recursive: true })
    fs.writeFileSync(path.join(addonDir, 'package.json'), JSON.stringify({ name: pkg, version }))
    entries.set(id, {
      addon: { manifest: { id, name: id } },
      initialized: true,
      source: 'installed',
      packageName: pkg,
      packageVersion: version,
      declaredCapabilities: [],
      addonDir,
      declaration: declaration(id),
    })
  }

  return {
    registry,
    disk,
    info,
    get process() {
      return state.process
    },
    set process(value: LoadedProcess) {
      state.process = value
    },
    get holdNextRestart() {
      return state.holdNextRestart
    },
    set holdNextRestart(value: boolean) {
      state.holdNextRestart = value
    },
    get releaseRestart() {
      return state.releaseRestart
    },
    get restarts() {
      return state.restarts
    },
  }
}

function restartedLine(info: InfoMock, version: string): string | undefined {
  for (const call of info.mock.calls) {
    const message = call[0]
    if (typeof message === 'string' && message.includes(`Addon restarted — v${version}`)) {
      return message
    }
  }
  return undefined
}

describe('grouped runner updates in quick succession', () => {
  it('respawns again when a second member is swapped after the first respawn returned', async () => {
    const h = harness()
    h.disk[HA] = '99.2.701'
    const ha = Reflect.get(h.registry, 'addonEntries') as Map<string, { packageVersion: string }>
    ha.get(HA)!.packageVersion = '99.2.701'
    const first = await h.registry.restartAddon(HA)
    expect(first.success).toBe(true)
    expect(h.process.loaded[HA]).toBe('99.2.701')
    expect(h.process.pid).not.toBe(1948)

    // Still inside the old 10s coalesce window — the bug dropped this swap.
    h.disk[GOOGLE] = '99.1.126'
    ha.get(GOOGLE)!.packageVersion = '99.1.126'
    const second = await h.registry.restartAddon(GOOGLE)

    expect(second.success).toBe(true)
    expect(h.process.loaded[GOOGLE]).toBe('99.1.126')
    expect(h.restarts).toBe(2)
    const line = restartedLine(h.info, '99.1.126')
    expect(line, 'restart is logged only once the new process is up').toBeDefined()
    expect(line).toMatch(/runner pid \d+ -> \d+/)
    const pids = line!.match(/runner pid (\d+) -> (\d+)/)
    expect(pids?.[1]).not.toBe(pids?.[2])
  })

  it('does not let an in-flight fork satisfy a swap that landed after the fork started', async () => {
    const h = harness()
    h.disk[HA] = '99.2.701'
    const entries = Reflect.get(h.registry, 'addonEntries') as Map<
      string,
      { packageVersion: string }
    >
    entries.get(HA)!.packageVersion = '99.2.701'
    h.holdNextRestart = true

    const first = h.registry.restartAddon(HA)
    await vi.waitFor(() => {
      if (h.releaseRestart === null) throw new Error('fork has not started')
    })

    h.disk[GOOGLE] = '99.1.126'
    entries.get(GOOGLE)!.packageVersion = '99.1.126'
    const second = h.registry.restartAddon(GOOGLE)
    h.releaseRestart?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.success).toBe(true)
    expect(secondResult.success).toBe(true)
    expect(h.process.loaded[GOOGLE]).toBe('99.1.126')
    expect(h.restarts).toBeGreaterThanOrEqual(2)
    const line = restartedLine(h.info, '99.1.126')
    expect(line).toMatch(/runner pid \d+ -> \d+/)
  })
})
