/**
 * The HomeKit side of exporting actions (D968): the persisted selection, the
 * switch each entry becomes, the press that runs it through `actions.run`, the
 * refusal that is logged and never queued, and the pruning of an action the
 * operator deleted.
 */
import { Characteristic, Service } from '@homebridge/hap-nodejs'
import type { Accessory } from '@homebridge/hap-nodejs'
import type { ActionRunResult, ExportEntityApi, IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionExports, type ActionExportEntry, type ActionExportPorts } from '../action-exports.js'
import { ACTION_SWITCH_AUTO_OFF_MS } from '../action-switch.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeLogger(lines: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => void lines.push({ level: 'info', message, extras }),
    warn: (message, extras) => void lines.push({ level: 'warn', message, extras }),
    error: (message, extras) => void lines.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly exports: ActionExports
  readonly published: Accessory[]
  readonly unpublished: Accessory[]
  readonly persisted: ActionExportEntry[][]
  readonly run: ReturnType<typeof vi.fn>
  readonly lines: Line[]
  live: { id: string; name: string }[] | 'unanswered'
}

function harness(initial: readonly ActionExportEntry[] = []): Harness {
  const lines: Line[] = []
  const published: Accessory[] = []
  const unpublished: Accessory[] = []
  const persisted: ActionExportEntry[][] = []
  const run = vi.fn(
    async (_input: { actionId: string }): Promise<ActionRunResult> => ({
      runId: 'r',
      outcome: 'started',
    }),
  )
  const state: Pick<Harness, 'live'> = { live: [{ id: 'internal:a', name: 'Open gate' }] }
  const api: ExportEntityApi = {
    actions: {
      list: {
        query: async () => {
          if (state.live === 'unanswered') throw new Error('hub unreachable')
          return state.live
        },
      },
      run: { mutate: run },
    },
    notificationOutput: {
      listTargets: { query: async () => [] },
      send: { mutate: async () => ({ success: true }) },
    },
  }
  const ports: ActionExportPorts = {
    api,
    logger: makeLogger(lines),
    publish: async (a) => void published.push(a),
    unpublish: async (a) => void unpublished.push(a),
    persist: async (entries) => void persisted.push([...entries]),
  }
  const h = {
    exports: new ActionExports(ports, initial),
    published,
    unpublished,
    persisted,
    run,
    lines,
    get live() {
      return state.live
    },
    set live(v: Harness['live']) {
      state.live = v
    },
  }
  return h
}

function press(accessory: Accessory): void {
  accessory.getService(Service.Switch)?.getCharacteristic(Characteristic.On).setValue(true)
}

describe('ActionExports', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('exposing an action publishes one switch named after it and persists the selection', async () => {
    const h = harness()
    await h.exports.expose('internal:a')
    expect(h.published).toHaveLength(1)
    expect(h.published[0]?.displayName).toBe('Open gate')
    expect(h.persisted.at(-1)).toEqual([
      expect.objectContaining({ actionId: 'internal:a', displayName: 'Open gate' }),
    ])
    expect(h.exports.list()).toEqual([
      { entity: { kind: 'action', actionId: 'internal:a' }, exposedAs: 'Open gate' },
    ])
  })

  it('refuses to expose an action that does not exist', async () => {
    const h = harness()
    await expect(h.exports.expose('internal:nope')).rejects.toThrow(/internal:nope/)
    expect(h.published).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
  })

  it('a press runs the action through actions.run, and the switch pulses off by itself', async () => {
    const h = harness()
    await h.exports.expose('internal:a')
    const accessory = h.published[0]
    if (accessory === undefined) throw new Error('not published')
    press(accessory)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.run).toHaveBeenCalledWith({ actionId: 'internal:a' })
    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS)
    const on = accessory.getService(Service.Switch)?.getCharacteristic(Characteristic.On)
    expect(on?.value).toBe(false)
  })

  it('an action that is already running is refused with a named reason, once, never queued', async () => {
    const h = harness()
    h.run.mockResolvedValue({ runId: 'r', outcome: 'skipped-overlap' })
    await h.exports.expose('internal:a')
    const accessory = h.published[0]
    if (accessory === undefined) throw new Error('not published')
    press(accessory)
    await vi.advanceTimersByTimeAsync(ACTION_SWITCH_AUTO_OFF_MS * 3)
    expect(h.run).toHaveBeenCalledTimes(1)
    const warn = h.lines.find((l) => l.level === 'warn')
    expect(warn?.message).toContain('already-running')
    expect(warn?.extras?.tags).toEqual({ actionId: 'internal:a' })
  })

  it('attachAll republishes the persisted selection after a restart', async () => {
    const h = harness([{ actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 }])
    await h.exports.attachAll()
    expect(h.published).toHaveLength(1)
  })

  it('reconcile drops an action that was deleted, unpublishes it and logs the drop', async () => {
    const h = harness([
      { actionId: 'internal:a', displayName: 'Open gate', addedAt: 1 },
      { actionId: 'internal:gone', displayName: 'Old', addedAt: 2 },
    ])
    await h.exports.attachAll()
    await h.exports.reconcile()
    expect(h.unpublished).toHaveLength(1)
    expect(h.unpublished[0]?.displayName).toBe('Old')
    expect(h.persisted.at(-1)?.map((e) => e.actionId)).toEqual(['internal:a'])
    expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('deleted'))).toBe(true)
  })

  it('reconcile on an UNANSWERED list changes nothing (a failed read destroys no work)', async () => {
    const h = harness([{ actionId: 'internal:gone', displayName: 'Old', addedAt: 2 }])
    await h.exports.attachAll()
    h.live = 'unanswered'
    await h.exports.reconcile()
    expect(h.unpublished).toHaveLength(0)
    expect(h.persisted).toHaveLength(0)
    expect(h.exports.list()).toHaveLength(1)
  })

  it('unexpose unpublishes and persists the shorter selection', async () => {
    const h = harness()
    await h.exports.expose('internal:a')
    await h.exports.unexpose('internal:a')
    expect(h.unpublished).toHaveLength(1)
    expect(h.persisted.at(-1)).toEqual([])
    expect(h.exports.list()).toEqual([])
  })
})
