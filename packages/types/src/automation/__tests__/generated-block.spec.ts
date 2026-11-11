// @vitest-environment node
/**
 * The generated block, RUN against a fake ctx. The string assertions in
 * codegen.spec.ts say what the source contains; these say what it DOES.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateAutomationBlock } from '../codegen.js'
import type { TimeSpec, WeekdayKey } from '../../time/time-spec.js'
import { DeviceType } from '../../device/device-type.js'
import { type FakeRegistry, fakeRegistry } from './target-fixtures.js'
import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type LegacyAutomationRecipe,
} from '../recipe.js'

/** What a fixture may be written as: the new tree, or the old shape the schema converts. */
type RecipeInput = LegacyAutomationRecipe | AutomationRecipe
import {
  appendTrace,
  type AutomationRunTrace,
  type AutomationStateDoc,
  EMPTY_AUTOMATION_STATE,
} from '../trace.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const SHIM = path.join(HERE, 'generated-block-shim.ts')

interface LogLine {
  readonly level: string
  readonly msg: string
  readonly meta: Record<string, unknown> | undefined
}

type Handler = (event: {
  category: string
  deviceId?: number
  data: Record<string, unknown>
}) => void

interface Harness {
  readonly logs: LogLine[]
  readonly mutate: ReturnType<typeof vi.fn>
  readonly ledger: Ledger
  readonly reports: Array<Record<string, unknown>>
  readonly actionRuns: Array<Record<string, unknown>>
  readonly sliceReads: { count: number }
  emit(category: string, data: Record<string, unknown>, deviceId?: number): void
  traces(): AutomationRunTrace[]
  stop(): void
}

/** The hub's `runs` row for this block: what survives a block restart. */
interface Ledger {
  doc: AutomationStateDoc
}

type BlockFn = (ctx: unknown) => () => void

const workDir = mkdtempSync(path.join(tmpdir(), 'camstack-generated-block-'))
let seq = 0

/**
 * The shim (zod, the icon catalogue…) is ~1.2 MB once bundled. It is built ONCE and
 * every block imports it by URL: inlining it into each block kept one copy per test
 * alive in the module cache and ran the suite out of a 1.8 GB heap.
 */
let shimUrl: Promise<string> | undefined

function sharedShimUrl(): Promise<string> {
  shimUrl ??= build({
    entryPoints: [SHIM],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  }).then((out) => {
    const file = path.join(workDir, 'shim.mjs')
    writeFileSync(file, out.outputFiles[0]?.text ?? '')
    return pathToFileURL(file).href
  })
  return shimUrl
}

async function load(input: RecipeInput, name = 'Test automation'): Promise<BlockFn> {
  const source = generateAutomationBlock({ name, recipe: AutomationRecipeSchema.parse(input) })
  const shim = await sharedShimUrl()
  const bundled = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: HERE, sourcefile: 'generated.ts' },
    alias: { '@camstack/types': shim },
    external: [shim],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  const file = path.join(workDir, `block-${(seq += 1)}.mjs`)
  writeFileSync(file, bundled.outputFiles[0]?.text ?? '')
  const mod: { default: BlockFn } = await import(/* @vite-ignore */ pathToFileURL(file).href)
  return mod.default
}

interface Options {
  readonly slices?: Record<string, object>
  /** What `deviceManager.listAll({})` answers: the array, as production returns it. */
  readonly listing?: ReadonlyArray<{ id: number; stableId: string; addonId: string }>
  readonly failSliceReads?: boolean
  readonly ledger?: Ledger
  /** The hub cannot answer the stamp read. */
  readonly failStampRead?: boolean
  /** What `actions.run` answers. */
  readonly actionOutcome?: { outcome: string; message?: string }
  /** What the hub's template renderer answers per template (D1021). */
  readonly renderTemplate?: (
    source: string,
  ) => { ok: true; text: string } | { ok: false; reason: string }
  /** The device registry a domain target resolves against. */
  readonly registry?: FakeRegistry
  /** What `system.getSiteLocation` answers (default: Rome, located). */
  readonly site?: {
    readonly location: { latitude: number; longitude: number } | null
    readonly timeZone: string
  }
}

function start(block: BlockFn, options: Options = {}): Harness {
  const logs: LogLine[] = []
  const handlers: Array<{ category: string; deviceId?: number; handler: Handler }> = []
  const ledger: Ledger = options.ledger ?? { doc: EMPTY_AUTOMATION_STATE }
  const reports: Array<Record<string, unknown>> = []
  const actionRuns: Array<Record<string, unknown>> = []
  const sliceReads = { count: 0 }
  const mutate = vi.fn(async () => undefined)
  const log = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    logs.push({ level, msg, meta })
  }
  const ctx = {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    eventBus: {
      subscribe: (filter: { category: string; deviceId?: number }, handler: Handler) => {
        const entry = { category: filter.category, deviceId: filter.deviceId, handler }
        handlers.push(entry)
        return () => {
          handlers.splice(handlers.indexOf(entry), 1)
        }
      },
    },
    id: 'core-block-test-block',
    api: {
      coreBlocks: {
        getAutomationRunState: {
          query: async () => {
            if (options.failStampRead === true) throw new Error('hub busy')
            return ledger.doc
          },
        },
        reportAutomationRun: {
          mutate: async (input: {
            trace?: AutomationRunTrace
            runStartedAt?: number
            keepTraces?: number
          }) => {
            reports.push(input)
            ledger.doc = {
              ...ledger.doc,
              lastRunStartedAt: input.runStartedAt ?? ledger.doc.lastRunStartedAt,
              traces:
                input.trace === undefined
                  ? ledger.doc.traces
                  : appendTrace(ledger.doc.traces, input.trace, input.keepTraces ?? 20),
            }
          },
        },
      },
      actions: {
        run: {
          mutate: async (input: Record<string, unknown>) => {
            actionRuns.push(input)
            return { runId: 'r1', ...(options.actionOutcome ?? { outcome: 'ran' }) }
          },
        },
      },
      deviceState: {
        getCapSlice: {
          query: async (q: { deviceId: number; capName: string }) => {
            sliceReads.count += 1
            if (options.failSliceReads === true) throw new Error('hub busy')
            return options.slices?.[`${q.deviceId}|${q.capName}`]
          },
        },
      },
      deviceManager: {
        renderDeviceTemplates: {
          query: async (q: { templates: string[] }) => ({
            results: q.templates.map((source) => {
              const r = options.renderTemplate?.(source) ?? { ok: true as const, text: source }
              return r.ok
                ? { ok: true, text: r.text, trace: [] }
                : { ok: false, refusal: { reason: r.reason, message: r.reason }, trace: [] }
            }),
          }),
        },
        listAll: {
          query: async (q: { deviceIds?: number[] }) =>
            q.deviceIds === undefined
              ? (options.listing ?? [])
              : (options.registry?.directory.listDevices(q.deviceIds) ?? []),
        },
        listDeviceIdsByCaps: {
          query: async (q: { capNames: string[] }) =>
            options.registry?.directory.listDeviceIdsByCaps(q.capNames) ?? [],
        },
      },
      system: {
        getSiteLocation: {
          query: async () =>
            options.site ?? {
              location: { latitude: 41.9028, longitude: 12.4964 },
              timeZone: 'Europe/Rome',
            },
        },
      },
      siren: { on: { mutate } },
      cover: { open: { mutate } },
    },
  }
  const stop = block(ctx)
  return {
    logs,
    mutate,
    ledger,
    reports,
    actionRuns,
    sliceReads,
    emit: (category, data, deviceId) => {
      for (const h of [...handlers]) {
        if (h.category === category && (h.deviceId === undefined || h.deviceId === deviceId))
          h.handler({ category, deviceId, data })
      }
    },
    traces: () => ledger.doc.traces,
    stop,
  }
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

const SIREN = { kind: 'cap', deviceId: 616, cap: 'siren', method: 'on' } as const
const MOTION = { kind: 'device-event', category: 'motion.on-motion-changed' } as const
const WAIT_THEN_SIREN: AutomationRecipe['actions'] = [{ kind: 'wait', seconds: 10 }, SIREN]

beforeAll(() => {
  // esbuild is resolved from the workspace root; fail loudly if it is not there.
  expect(typeof build).toBe('function')
})
afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

describe('detection trigger', () => {
  it('fires ONE run per track over start + update + update, and traces the rest as one repeat', async () => {
    const block = await load({
      triggers: [{ kind: 'detection', classes: ['animal'], deviceIds: [7] }],
      actions: [{ kind: 'cap', deviceId: { $var: 'deviceId' }, cap: 'siren', method: 'on' }],
    })
    const h = start(block)
    await settle()
    const data = { deviceId: 7, trackId: 't1', bestClassName: 'dog', bestConfidence: 0.9 }
    h.emit('pipeline-analytics.track-lifecycle', { ...data, phase: 'start' })
    await settle()
    h.emit('pipeline-analytics.track-lifecycle', { ...data, phase: 'update' })
    h.emit('pipeline-analytics.track-lifecycle', { ...data, phase: 'update' })
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.mutate).toHaveBeenCalledWith({ deviceId: 7 })
    await settle(5_000) // a skip waits to be coalesced before it is reported
    const [ran, rejected] = h.traces()
    expect(ran).toMatchObject({ outcome: 'ran', trigger: { kind: 'detection', outcome: 'pass' } })
    expect(ran?.trigger.vars).toMatchObject({
      deviceId: 7,
      className: 'dog',
      trackId: 't1',
      score: 0.9,
    })
    expect(ran?.steps.map((s) => [s.path, s.outcome])).toEqual([['actions.0', 'ok']])
    expect(rejected).toMatchObject({
      outcome: 'skipped-trigger',
      repeat: 2,
      trigger: { outcome: 'fail', reason: 'already fired for track t1' },
    })
  })

  it('another device is not this automation: no run, no trace', async () => {
    const block = await load({
      triggers: [{ kind: 'detection', classes: ['person'], deviceIds: [7] }],
      actions: [SIREN],
    })
    const h = start(block)
    await settle()
    h.emit('pipeline-analytics.track-lifecycle', {
      deviceId: 8,
      trackId: 'x',
      phase: 'start',
      bestClassName: 'person',
      bestConfidence: 0.9,
    })
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()).toEqual([])
  })
})

describe('a schedule time spec (D983)', () => {
  const at = (spec: TimeSpec, days?: WeekdayKey[]): RecipeInput => ({
    when: { kind: 'schedule', at: spec, ...(days === undefined ? {} : { days }) },
    actions: [SIREN],
  })

  it('fires at the next occurrence in the site zone, then re-arms for the next day', async () => {
    vi.setSystemTime(new Date('2026-01-15T06:29:00Z')) // 07:29 in Rome
    const block = await load(at({ kind: 'clock', hh: 7, mm: 30 }))
    const h = start(block)
    await settle(30_000)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(31_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(24 * 3_600_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it('a sun spec on a site with no location does not fire and says why', async () => {
    vi.setSystemTime(new Date('2026-06-21T00:00:00Z'))
    const block = await load(at({ kind: 'sun', event: 'sunrise', offsetMin: 0 }))
    const h = start(block, { site: { location: null, timeZone: 'Europe/Rome' } })
    await settle(24 * 3_600_000)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.logs.find((l) => l.level === 'warn')?.meta).toMatchObject({
      reason: 'sun-needs-site-location',
    })
    h.stop()
  })

  it('a sun spec fires at sunrise plus the offset', async () => {
    vi.setSystemTime(new Date('2025-06-21T00:00:00Z'))
    const block = await load(at({ kind: 'sun', event: 'sunrise', offsetMin: 10 }))
    const h = start(block)
    await settle(3 * 3_600_000 + 40 * 60_000) // 03:40Z, sunrise is 03:35Z -> +10 = 03:45Z
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(10 * 60_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('the legacy cron schedule still compiles and fires', async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 29, 30)) // cron reads the host clock
    const block = await load({
      when: { kind: 'schedule', cron: '30 10 * * *' },
      actions: [SIREN],
    })
    const h = start(block)
    await settle(60_000)
    expect(h.mutate.mock.calls.length).toBeGreaterThanOrEqual(1)
    h.stop()
  })
})

describe('device value templates in action args (D1021)', () => {
  const NOTIFY: AutomationRecipe['actions'] = [
    {
      kind: 'cap',
      deviceId: 616,
      cap: 'siren',
      method: 'on',
      args: { message: "Temp {{ states('sensor.x') }}" },
    },
  ]

  it('renders a template arg through the hub renderer before the call', async () => {
    const block = await load({ when: MOTION, actions: NOTIFY })
    const h = start(block, { renderTemplate: () => ({ ok: true, text: 'Temp 21' }) })
    await settle()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle()
    expect(h.mutate.mock.calls[0]?.[0]).toMatchObject({ deviceId: 616, message: 'Temp 21' })
  })

  it('a refused render fails the step with the reason and dispatches nothing', async () => {
    const block = await load({ when: MOTION, actions: NOTIFY })
    const h = start(block, { renderTemplate: () => ({ ok: false, reason: 'budget-exceeded' }) })
    await settle()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()[0]?.steps[0]).toMatchObject({ outcome: 'error' })
    expect(JSON.stringify(h.traces()[0])).toContain('budget-exceeded')
  })
})

describe('a domain target (D983)', () => {
  const openIn = (roomId: string): AutomationRecipe['actions'] => [
    {
      kind: 'cap',
      actionId: 'cover.open',
      target: { kind: 'domain', roomId },
      cap: 'cover',
      method: 'open',
    },
  ]
  const covers = () =>
    fakeRegistry([
      { id: 1, caps: ['cover'], type: DeviceType.Cover, location: 'Living room' },
      { id: 2, caps: ['cover'], type: DeviceType.Cover, location: 'Kitchen' },
      { id: 3, caps: ['cover'], type: DeviceType.Cover, location: 'living room' },
    ])

  it('runs the action on every device of the room, traced per device, and a device registered later is included', async () => {
    const registry = covers()
    const block = await load({ when: MOTION, actions: openIn('Living room') })
    const h = start(block, { registry })
    await settle()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle()
    expect(
      h.mutate.mock.calls.map(([a]) => (a as { deviceId: number }).deviceId).toSorted(),
    ).toEqual([1, 3])
    expect(h.traces()[0]?.steps[0]).toMatchObject({
      actionId: 'cover.open',
      outcome: 'ok',
      devices: [
        { deviceId: 1, outcome: 'ok' },
        { deviceId: 3, outcome: 'ok' },
      ],
    })
    registry.devices.set(9, {
      id: 9,
      caps: ['cover'],
      type: DeviceType.Cover,
      location: 'Living room',
      disabled: false,
    })
    h.emit('device.registered', {}, 9)
    h.mutate.mockClear()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle(1)
    await settle()
    expect(
      h.mutate.mock.calls.map(([a]) => (a as { deviceId: number }).deviceId).toSorted(),
    ).toEqual([1, 3, 9])
  })

  it('an empty domain is logged and the step is traced `empty`, never a silent no-op', async () => {
    const block = await load({
      when: MOTION,
      actions: openIn('Attic'),
    })
    const h = start(block, { registry: covers() })
    await settle()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()[0]?.steps[0]).toMatchObject({ outcome: 'empty' })
    expect(h.logs.some((l) => l.level === 'warn' && l.msg.includes('resolved to no devices'))).toBe(
      true,
    )
  })
})

describe('interval trigger', () => {
  it('fires after a jittered first delay, then every N minutes, and stops on dispose', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const block = await load({ triggers: [{ kind: 'interval', minutes: 5 }], actions: [SIREN] })
    const h = start(block)
    await settle(5)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(5 * 60_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
    h.stop()
    await settle(10 * 60_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })
})

describe('run modes', () => {
  it('cooldown: a second fire inside the window is skipped and traced; after it, runs', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: [SIREN],
      runMode: { mode: 'cooldown', minutes: 30 },
    })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle()
    await settle(60_000)
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(5_000) // a skip waits to be coalesced before it is reported
    expect(h.traces().map((t) => t.outcome)).toEqual(['ran', 'skipped-cooldown'])
    expect(h.traces()[1]?.verdict).toMatchObject({
      mode: { mode: 'cooldown' },
      decision: 'cooldown',
    })
    expect(h.traces()[1]?.verdict?.reason).toContain('min left')
    await settle(31 * 60_000)
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })

  it('cooldown survives a restart: a new block reads the stamp from the hub ledger', async () => {
    const recipe: RecipeInput = {
      triggers: [MOTION],
      actions: [SIREN],
      runMode: { mode: 'cooldown', minutes: 30 },
    }
    const block = await load(recipe)
    const first = start(block)
    await settle()
    first.emit('motion.on-motion-changed', {})
    await settle()
    expect(first.mutate).toHaveBeenCalledTimes(1)
    first.stop()
    const second = start(block, { ledger: first.ledger })
    await settle()
    second.emit('motion.on-motion-changed', {})
    await settle()
    expect(second.mutate).not.toHaveBeenCalled()
    await settle(5_000) // a skip waits to be coalesced before it is reported
    expect(second.traces().map((t) => t.outcome)).toEqual(['ran', 'skipped-cooldown'])
  })

  it('single: a trigger arriving while actions run is dropped, traced AND logged', async () => {
    const block = await load({ triggers: [MOTION], actions: WAIT_THEN_SIREN })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {}, 5)
    await settle()
    h.emit('motion.on-motion-changed', {}, 5)
    await settle(10_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    const dropped = h.traces().find((t) => t.outcome === 'skipped-overlap')
    expect(dropped?.verdict).toMatchObject({ mode: { mode: 'single' }, decision: 'drop' })
    expect(dropped?.verdict?.reason).toContain('single')
    expect(h.logs.some((l) => l.msg.startsWith('automation trigger dropped'))).toBe(true)
  })

  it('queued: runs one, queues up to max, drops the rest, then drains the queue', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: WAIT_THEN_SIREN,
      runMode: { mode: 'queued', max: 1 },
    })
    const h = start(block)
    await settle()
    for (let i = 0; i < 3; i += 1) h.emit('motion.on-motion-changed', {})
    await settle()
    await settle(10_000)
    await settle(10_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
    const traces = h.traces()
    expect(traces.map((t) => t.outcome).sort()).toEqual(['ran', 'ran', 'skipped-overlap'])
    expect(traces.find((t) => t.outcome === 'skipped-overlap')?.verdict?.reason).toContain(
      'queue is full (1)',
    )
    expect(traces.some((t) => t.verdict?.decision === 'queued' && t.outcome === 'ran')).toBe(true)
  })

  it('restart: the run in progress is aborted at its step boundary, the new one runs', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: WAIT_THEN_SIREN,
      runMode: { mode: 'restart' },
    })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle(1_000)
    h.emit('motion.on-motion-changed', {})
    await settle(10_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    const traces = h.traces()
    const aborted = traces.find((t) => t.outcome === 'aborted')
    expect(aborted?.steps.map((s) => s.outcome)).toEqual(['ok', 'not-run'])
    expect(traces.find((t) => t.outcome === 'ran')?.verdict).toMatchObject({ decision: 'restart' })
  })

  it('parallel: up to max at once, the rest dropped', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: WAIT_THEN_SIREN,
      runMode: { mode: 'parallel', max: 2 },
    })
    const h = start(block)
    await settle()
    for (let i = 0; i < 3; i += 1) h.emit('motion.on-motion-changed', {})
    await settle(10_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
    expect(
      h
        .traces()
        .map((t) => t.outcome)
        .sort(),
    ).toEqual(['ran', 'ran', 'skipped-overlap'])
  })
})

describe('conditions read the mirror, not the hub', () => {
  const gate: AutomationRecipe = {
    when: {
      kind: 'all',
      children: [
        MOTION,
        {
          kind: 'device-is',
          deviceId: 3,
          cap: 'sensor',
          fieldPath: 'bowl',
          operator: 'gte',
          value: 5,
        },
      ],
    },
    actions: [SIREN],
  }

  it('unknown mirror value => false, logged with the device tag, traced with its reason', async () => {
    const h = start(await load(gate), { failSliceReads: true })
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(5_000) // a skip waits to be coalesced before it is reported
    const t = h.traces()[0]
    expect(t).toMatchObject({ outcome: 'skipped-conditions' })
    expect(t?.conditions.find((n) => n.kind === 'device-is')).toMatchObject({
      path: 'when.1',
      outcome: 'fail',
      reason: 'bowl value unknown → fail',
      observed: null,
    })
    expect(
      h.logs.some((l) => l.level === 'warn' && JSON.stringify(l.meta).includes('"deviceId":3')),
    ).toBe(true)
  })

  it('fire time does no read: the value comes from the fill, then from a state-changed event', async () => {
    const h = start(await load(gate), { slices: { '3|sensor': { bowl: 0 } } })
    await settle()
    const readsAfterFill = h.sliceReads.count
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(5_000) // a skip waits to be coalesced before it is reported
    expect(h.traces()[0]?.conditions.find((n) => n.kind === 'device-is')).toMatchObject({
      outcome: 'fail',
      reason: 'bowl 0, expected ≥ 5 → fail',
    })
    h.emit('device.state-changed', { deviceId: 3, capName: 'sensor', slice: { bowl: 8 } })
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.sliceReads.count).toBe(readsAfterFill)
  })
})

describe('action steps', () => {
  it('an error stops the sequence: the failing step carries the message, the rest are not-run', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: [{ kind: 'cap', deviceId: 616, cap: 'nope', method: 'on' }, SIREN],
    })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    const t = h.traces()[0]
    expect(t?.outcome).toBe('failed')
    expect(t?.steps).toMatchObject([
      {
        path: 'actions.0',
        outcome: 'error',
        message: 'no such device method: nope.on',
        deviceId: 616,
      },
      { path: 'actions.1', outcome: 'not-run' },
    ])
  })
})

describe('step args in the trace', () => {
  it('a ran step records what it sent, with a secret-named parameter redacted', async () => {
    const block = await load({
      triggers: [MOTION],
      actions: [
        {
          kind: 'cap',
          deviceId: 616,
          cap: 'siren',
          method: 'on',
          args: { level: 3, mode: 'night', password: 'hunter2' },
        },
      ],
    })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    const step = h.traces()[0]?.steps[0]
    expect(step?.args).toEqual({ level: 3, mode: 'night', password: '[redacted]' })
    expect(JSON.stringify(h.traces())).not.toContain('hunter2')
  })
})

describe('action step', () => {
  const ACTION: AutomationRecipe['actions'] = [
    {
      kind: 'action',
      actionId: 'internal:night',
      variables: { zone: '{{vars.deviceId}}', level: 3 },
    },
    SIREN,
  ]

  it('runs the Action awaited, with substituted variables and the block as origin', async () => {
    const block = await load({ triggers: [MOTION], actions: ACTION })
    const h = start(block)
    await settle()
    h.emit('motion.on-motion-changed', {}, 616)
    await settle()
    expect(h.actionRuns).toEqual([
      {
        actionId: 'internal:night',
        variables: { zone: '616', level: 3 },
        wait: true,
        origin: { blockId: 'test-block' },
      },
    ])
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.traces()[0]).toMatchObject({ outcome: 'ran' })
  })

  it('an Action that did not run fails THIS step and leaves the next one not-run', async () => {
    const block = await load({ triggers: [MOTION], actions: ACTION })
    const h = start(block, {
      actionOutcome: { outcome: 'skipped-overlap', message: 'the action is already running' },
    })
    await settle()
    h.emit('motion.on-motion-changed', {}, 616)
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()[0]?.outcome).toBe('failed')
    expect(h.traces()[0]?.steps).toMatchObject([
      {
        path: 'actions.0',
        kind: 'action',
        outcome: 'error',
        message: 'action internal:night skipped-overlap: the action is already running',
      },
      { path: 'actions.1', outcome: 'not-run' },
    ])
  })
})

describe('stationary trigger and condition', () => {
  const STATIONARY = 'pipeline-analytics.stationary-changed'
  const born = {
    deviceId: 7,
    entryId: 'e1',
    className: 'car',
    phase: 'appeared',
    zones: ['drive'],
  }

  it('fires on an appeared event and hands deviceId, className, zones, phase, entryId to the steps', async () => {
    const block = await load({
      triggers: [{ kind: 'stationary', deviceIds: [7], classes: ['vehicle'], phase: 'appeared' }],
      actions: [{ kind: 'cap', deviceId: { $var: 'deviceId' }, cap: 'siren', method: 'on' }],
    })
    const h = start(block)
    await settle()
    h.emit(STATIONARY, { ...born, phase: 'departed' })
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    h.emit(STATIONARY, born)
    await settle()
    expect(h.mutate).toHaveBeenCalledWith({ deviceId: 7 })
    expect(h.traces()[0]?.trigger).toMatchObject({ kind: 'stationary', outcome: 'pass' })
    expect(h.traces()[0]?.trigger.vars).toMatchObject({
      deviceId: 7,
      className: 'car',
      zones: ['drive'],
      phase: 'appeared',
      entryId: 'e1',
    })
  })

  it('a class or zone mismatch is traced and never fires', async () => {
    const block = await load({
      triggers: [{ kind: 'stationary', deviceIds: [7], zones: ['garage'], phase: 'appeared' }],
      actions: [SIREN],
    })
    const h = start(block)
    await settle()
    h.emit(STATIONARY, born)
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()[0]).toMatchObject({ outcome: 'skipped-trigger' })
    expect(h.traces()[0]?.trigger.reason).toContain('zone')
  })

  it('stationary-present reads the zone-analytics slice: runs when parked, skips when not', async () => {
    const recipe: RecipeInput = {
      triggers: [MOTION],
      conditions: { kind: 'stationary-present', deviceId: 7, classes: ['vehicle'] },
      actions: [SIREN],
    }
    const block = await load(recipe)
    const parked = start(block, {
      slices: {
        '7|zone-analytics': {
          frame: { totalObjects: 1 },
          zones: [],
          stationaryObjects: [{ id: 'e1', className: 'car' }],
        },
      },
    })
    await settle()
    parked.emit('motion.on-motion-changed', {}, 616)
    await settle()
    expect(parked.mutate).toHaveBeenCalledTimes(1)
    parked.stop()

    const none = start(block, {
      slices: { '7|zone-analytics': { frame: { totalObjects: 0 }, zones: [] } },
    })
    await settle()
    none.emit('motion.on-motion-changed', {}, 616)
    await settle(5_000)
    expect(none.mutate).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('one when tree: an instant is an event, the rest is state', () => {
  const lightOn = {
    kind: 'device-becomes',
    deviceId: 5,
    cap: 'switch',
    fieldPath: 'on',
    becomes: true,
  } as const
  const doorOpenNow = {
    kind: 'device-is',
    deviceId: 3,
    cap: 'contact',
    fieldPath: 'open',
    operator: 'eq',
    value: true,
  } as const
  const doorOpens = { ...lightOn, deviceId: 3, cap: 'contact', fieldPath: 'open' } as const
  const lightOnNow = {
    ...doorOpenNow,
    deviceId: 5,
    cap: 'switch',
    fieldPath: 'on',
  } as const
  const lightEvent = (h: Harness): void =>
    h.emit('device.state-changed', { deviceId: 5, capName: 'switch', slice: { on: true } }, 5)
  const doorEvent = (h: Harness): void =>
    h.emit('device.state-changed', { deviceId: 3, capName: 'contact', slice: { open: true } }, 3)

  it('rule 1: fires when the event occurs AND the rest of the tree is true at that instant', async () => {
    const slices: Record<string, object> = {
      '3|contact': { open: true },
      '5|switch': { on: false },
    }
    const h = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices },
    )
    await settle()
    slices['5|switch'] = { on: true } // the light turns on: the instant
    lightEvent(h)
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.traces()[0]).toMatchObject({ outcome: 'ran', trigger: { kind: 'device-becomes' } })
    expect(h.traces()[0]?.trigger.vars).toMatchObject({ deviceId: 5 })
  })

  it('rule 1: the same event with the state false does not fire, and says which row failed', async () => {
    const slices: Record<string, object> = {
      '3|contact': { open: false },
      '5|switch': { on: false },
    }
    const h = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices },
    )
    await settle()
    slices['5|switch'] = { on: true }
    lightEvent(h)
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces()[0]).toMatchObject({ outcome: 'skipped-conditions' })
  })

  it('rule 1: the OTHER event is false in the instant — it does not fire an all of two events’ sibling state', async () => {
    // "light becomes on while door open": the door opening alone must not fire it.
    const h = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices: { '3|contact': { open: false }, '5|switch': { on: true } } },
    )
    await settle()
    doorEvent(h)
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('rule 1: only the event that occurred is true — every other event leaf is false in that instant', async () => {
    // (light becomes on AND door open) OR (door opens AND light on). The light
    // event occurs with the door closed: the first branch fails on its state, the
    // second must fail because the door did NOT open.
    const h = start(
      await load({
        when: {
          kind: 'any',
          children: [
            { kind: 'all', children: [lightOn, doorOpenNow] },
            { kind: 'all', children: [doorOpens, lightOnNow] },
          ],
        },
        actions: [SIREN],
      }),
      { slices: { '3|contact': { open: false }, '5|switch': { on: true } } },
    )
    await settle()
    lightEvent(h)
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('conversion equivalence: "light becomes on while door open" differs from "door opens while light already on", by the marked trace', async () => {
    const sliceA: Record<string, object> = {
      '3|contact': { open: true },
      '5|switch': { on: false },
    }
    const sliceB: Record<string, object> = {
      '3|contact': { open: false },
      '5|switch': { on: true },
    }
    const a = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices: sliceA },
    )
    const b = start(
      await load({ when: { kind: 'all', children: [doorOpens, lightOnNow] }, actions: [SIREN] }),
      { slices: sliceB },
    )
    await settle()
    doorEvent(a) // a re-report of an unchanged door: no instant for A
    sliceB['3|contact'] = { open: true } // the door opens: the instant for B
    doorEvent(b)
    await settle(5_000)
    expect(a.mutate).not.toHaveBeenCalled()
    expect(b.mutate).toHaveBeenCalledTimes(1)
    expect(b.traces()[0]?.trigger.vars).toMatchObject({ deviceId: 3 })
    sliceA['5|switch'] = { on: true } // the light turns on: the instant for A
    lightEvent(a)
    await settle(5_000)
    expect(a.mutate).toHaveBeenCalledTimes(1)
    expect(a.traces().find((t) => t.outcome === 'ran')?.trigger.vars).toMatchObject({ deviceId: 5 })
  })

  const bothNow: AutomationRecipe = {
    when: { kind: 'all', children: [doorOpenNow, lightOnNow] },
    actions: [SIREN],
  }

  it('rule 2: a state-only tree already true at start does NOT fire (the first evaluation seeds)', async () => {
    const h = start(await load(bothNow), {
      slices: { '3|contact': { open: true }, '5|switch': { on: true } },
    })
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('rule 2: fires on false → true, once, and not again while it stays true', async () => {
    const h = start(await load(bothNow), {
      slices: { '3|contact': { open: false }, '5|switch': { on: true } },
    })
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    doorEvent(h)
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    doorEvent(h)
    lightEvent(h)
    await settle(5_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    // false again, then true again: a second fire.
    h.emit('device.state-changed', { deviceId: 3, capName: 'contact', slice: { open: false } }, 3)
    await settle()
    doorEvent(h)
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })

  it('rule 2: an unreadable state is unknown, not false — it neither seeds nor fires', async () => {
    const h = start(await load(bothNow), { failSliceReads: true })
    await settle(5_000)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('a conditional step (#472)', () => {
  const IF_ON = {
    kind: 'device-is',
    deviceId: 5,
    cap: 'switch',
    fieldPath: 'on',
    operator: 'eq',
    value: true,
  } as const
  const GUARDED: AutomationRecipe['actions'] = [
    {
      kind: 'cap',
      deviceId: 616,
      cap: 'siren',
      method: 'on',
      args: { label: 'then' },
      if: IF_ON,
      else: [{ kind: 'cap', deviceId: 616, cap: 'siren', method: 'on', args: { label: 'else' } }],
    },
  ]
  const fire = async (slices: Record<string, object> | undefined) => {
    const h = start(
      await load({ when: MOTION, actions: GUARDED }),
      slices === undefined ? {} : { slices },
    )
    await settle()
    h.emit('motion.on-motion-changed', {}, 1)
    await settle()
    return h
  }

  it('true runs the step, false runs the else, unknown runs neither and says why', async () => {
    const yes = await fire({ '5|switch': { on: true } })
    expect(yes.mutate.mock.calls.map(([a]) => (a as { label: string }).label)).toEqual(['then'])
    expect(yes.traces()[0]?.steps[0]).toMatchObject({ outcome: 'ok', condition: 'true' })

    const no = await fire({ '5|switch': { on: false } })
    expect(no.mutate.mock.calls.map(([a]) => (a as { label: string }).label)).toEqual(['else'])
    expect(no.traces()[0]?.steps[0]).toMatchObject({ condition: 'false' })

    const unknown = await fire(undefined)
    expect(unknown.mutate).not.toHaveBeenCalled()
    expect(unknown.traces()[0]?.steps[0]).toMatchObject({
      outcome: 'skipped',
      condition: 'unknown',
    })
    const line = unknown.logs.find(
      (l) => l.level === 'warn' && l.msg.includes('condition could not be read'),
    )
    expect(line?.meta).toMatchObject({ tags: { deviceId: 616 }, step: 0 })
  })

  it('a stable-id leaf resolves through the device listing: true runs the step, false runs the else', async () => {
    const STABLE_IF = {
      kind: 'expression',
      expr: 'outdoor < 5',
      bindings: {
        outdoor: {
          kind: 'global',
          sourceStableId: 'ha:out',
          cap: 'sensor',
          fieldPath: 'value',
          addonId: 'ha',
        },
      },
    } as const
    const block = await load({
      when: MOTION,
      actions: [{ ...GUARDED[0]!, if: STABLE_IF } as AutomationRecipe['actions'][number]],
    })
    const listing = [{ id: 9, stableId: 'ha:out', addonId: 'ha' }]
    const run = async (value: number) => {
      const h = start(block, { listing, slices: { '9|sensor': { value } } })
      await settle()
      h.emit('motion.on-motion-changed', {}, 1)
      await settle()
      return h
    }
    const cold = await run(2)
    expect(cold.mutate.mock.calls.map(([a]) => (a as { label: string }).label)).toEqual(['then'])
    const warm = await run(20)
    expect(warm.mutate.mock.calls.map(([a]) => (a as { label: string }).label)).toEqual(['else'])
  })
})

describe('device-becomes: hold semantics (#498)', () => {
  const KEY = '5|switch'
  const wake = (h: Harness): void =>
    h.emit('device.state-changed', { deviceId: 5, capName: 'switch' }, 5)
  const set = (slices: Record<string, object>, value: unknown): void => {
    slices[KEY] = { on: value }
  }
  const becomes = (extra: Record<string, unknown>): RecipeInput => ({
    when: {
      kind: 'device-becomes',
      deviceId: 5,
      cap: 'switch',
      fieldPath: 'on',
      ...extra,
    } as AutomationRecipe['when'],
    actions: [SIREN],
  })

  it('bug 1: any change + hold fires once, after the value stayed for the whole window', async () => {
    const slices: Record<string, object> = { [KEY]: { on: 1 } }
    const h = start(await load(becomes({ forMs: 10_000 })), { slices })
    await settle()
    set(slices, 2)
    wake(h)
    await settle(9_000)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(2_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(120_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('bug 1: a change inside the window restarts it', async () => {
    const slices: Record<string, object> = { [KEY]: { on: 1 } }
    const h = start(await load(becomes({ forMs: 10_000 })), { slices })
    await settle()
    set(slices, 2)
    wake(h)
    await settle(6_000)
    set(slices, 3)
    wake(h)
    await settle(6_000)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(5_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('bug 2: edge + hold fires', async () => {
    const slices: Record<string, object> = { [KEY]: { on: false } }
    const h = start(await load(becomes({ becomes: true, edge: true, forMs: 10_000 })), { slices })
    await settle()
    set(slices, true)
    wake(h)
    await settle(12_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('bug 3: a held value fires ONCE per episode, and again only after it left and came back', async () => {
    const slices: Record<string, object> = { [KEY]: { on: false } }
    const h = start(await load(becomes({ becomes: true, forMs: 10_000 })), { slices })
    await settle()
    set(slices, true)
    wake(h)
    await settle(100_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    set(slices, false)
    wake(h)
    await settle(1_000)
    set(slices, true)
    wake(h)
    await settle(12_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })

  it('bug 3: a dip inside the window cancels the hold', async () => {
    const slices: Record<string, object> = { [KEY]: { on: false } }
    const h = start(await load(becomes({ becomes: true, forMs: 10_000 })), { slices })
    await settle()
    set(slices, true)
    wake(h)
    await settle(5_000)
    set(slices, false)
    wake(h)
    await settle(30_000)
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('bug 4: without hold or edge it never fires on a re-report or on the reconcile', async () => {
    const slices: Record<string, object> = { [KEY]: { on: true } }
    const h = start(await load(becomes({ becomes: true })), { slices })
    await settle()
    wake(h)
    await settle(60_000)
    expect(h.mutate).not.toHaveBeenCalled()
    set(slices, false)
    wake(h)
    await settle(1_000)
    set(slices, true)
    wake(h)
    await settle(1_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    wake(h)
    await settle(60_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('bug 5: the deadline is a timer, not the next reconcile', async () => {
    const slices: Record<string, object> = { [KEY]: { on: false } }
    const h = start(await load(becomes({ becomes: true, forMs: 3_000 })), { slices })
    await settle()
    set(slices, true)
    wake(h)
    await settle(2_900)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(1_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })
})

describe('hold semantics: for / operator on device-becomes, device-is and guards (#498)', () => {
  const KEY = '9|meter'
  const wake = (h: Harness, slice: Record<string, unknown> = {}): void =>
    h.emit('device.state-changed', { deviceId: 9, capName: 'meter', slice }, 9)
  const put = (slices: Record<string, object>, power: number): void => {
    slices[KEY] = { power }
  }
  const leaf = (extra: Record<string, unknown>): RecipeInput => ({
    when: {
      kind: 'device-becomes',
      deviceId: 9,
      cap: 'meter',
      fieldPath: 'power',
      ...extra,
    } as AutomationRecipe['when'],
    actions: [SIREN],
  })
  const heldOver = { operator: 'gt', value: 3000, for: { ms: 300_000, mode: 'held' } }

  it('stable: "unchanged (±0.5) for 30 s" fires once, 30 s after the last change, and again only after a new change', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 100 } }
    const h = start(await load(leaf({ for: { ms: 30_000, mode: 'stable', tolerance: 0.5 } })), {
      slices,
    })
    await settle()
    put(slices, 120)
    wake(h)
    await settle(10_000)
    put(slices, 120.3) // inside the tolerance: not a change
    wake(h)
    await settle(19_000)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(2_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(300_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    put(slices, 150)
    wake(h)
    await settle(31_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })

  it('stable: a move beyond the tolerance restarts the window', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 100 } }
    const h = start(await load(leaf({ for: { ms: 30_000, mode: 'stable', tolerance: 0.5 } })), {
      slices,
    })
    await settle()
    put(slices, 120)
    wake(h)
    await settle(20_000)
    put(slices, 121)
    wake(h)
    await settle(20_000)
    expect(h.mutate).not.toHaveBeenCalled()
    await settle(11_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('threshold + hold: "power > 3000 for 5 min" fires once per episode', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 2000 } }
    const h = start(await load(leaf(heldOver)), { slices })
    await settle()
    put(slices, 3500)
    wake(h)
    await settle(299_000)
    expect(h.mutate).not.toHaveBeenCalled()
    put(slices, 3700) // still above: the same episode
    wake(h)
    await settle(2_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    await settle(600_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('threshold + hold: a dip below inside the window cancels it, and the trace says pending then cancelled', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 2000 } }
    const h = start(await load(leaf(heldOver)), { slices })
    await settle()
    put(slices, 3500)
    wake(h)
    await settle(120_000)
    put(slices, 2900)
    wake(h)
    await settle(600_000)
    expect(h.mutate).not.toHaveBeenCalled()
    const phases = h.traces().map((t) => t.trigger.hold?.phase)
    expect(phases).toEqual(['pending', 'cancelled'])
    expect(h.traces()[1]?.trigger.reason).toContain('cancelled')
  })

  it('a fired hold is on the run trace', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 2000 } }
    const h = start(await load(leaf({ ...heldOver, for: { ms: 10_000, mode: 'held' } })), {
      slices,
    })
    await settle()
    put(slices, 3500)
    wake(h)
    await settle(11_000)
    const ran = h.traces().find((t) => t.outcome === 'ran')
    expect(ran?.trigger.hold).toMatchObject({ phase: 'fired', ms: 10_000, mode: 'held' })
  })

  it('crossing without a hold fires on the transition only, again after it left', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 2000 } }
    const h = start(await load(leaf({ operator: 'gt', value: 3000 })), { slices })
    await settle()
    put(slices, 3500)
    wake(h)
    await settle(1_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    put(slices, 3600)
    wake(h)
    await settle(60_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    put(slices, 1000)
    wake(h)
    await settle(1_000)
    put(slices, 4000)
    wake(h)
    await settle(1_000)
    expect(h.mutate).toHaveBeenCalledTimes(2)
  })

  it('a range: enters fires, leaves fires on "outside"', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 10 } }
    const enter = start(await load(leaf({ operator: 'between', value: [18, 24] })), { slices })
    await settle()
    put(slices, 20)
    wake(enter)
    await settle(1_000)
    expect(enter.mutate).toHaveBeenCalledTimes(1)
    const leave = start(await load(leaf({ operator: 'outside', value: [18, 24] })), { slices })
    await settle()
    put(slices, 30)
    wake(leave)
    await settle(1_000)
    expect(leave.mutate).toHaveBeenCalledTimes(1)
  })

  it('a restart re-seeds a running hold without firing it, and says so on the trace', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 3500 } }
    const h = start(await load(leaf({ ...heldOver, for: { ms: 10_000, mode: 'held' } })), {
      slices,
    })
    await settle(60_000)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.traces().map((t) => t.trigger.hold?.phase)).toEqual(['reseeded'])
    put(slices, 1000)
    wake(h)
    await settle(1_000)
    put(slices, 4000)
    wake(h)
    await settle(11_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('a failed read never cancels a hold (D49)', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 2000 } }
    const h = start(await load(leaf({ ...heldOver, for: { ms: 30_000, mode: 'held' } })), {
      slices,
    })
    await settle()
    put(slices, 3500)
    wake(h)
    await settle(5_000)
    delete slices[KEY] // the mirror cannot answer
    wake(h)
    await settle(40_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  it('a legacy leaf (forMs, edge) still runs: forMs reads as a held window', async () => {
    const slices: Record<string, object> = { [KEY]: { power: 0 } }
    const h = start(await load(leaf({ becomes: 5, edge: true, forMs: 4_000 })), { slices })
    await settle()
    put(slices, 5)
    wake(h)
    await settle(5_000)
    expect(h.mutate).toHaveBeenCalledTimes(1)
  })

  describe('a state leaf with a hold', () => {
    const power = (extra: Record<string, unknown>): RecipeInput => ({
      when: {
        kind: 'device-is',
        deviceId: 9,
        cap: 'meter',
        fieldPath: 'power',
        operator: 'gt',
        value: 3000,
        for: { ms: 300_000, mode: 'held' },
        ...extra,
      } as AutomationRecipe['when'],
      actions: [SIREN],
    })

    it('"power > 3000 for 5 min" fires once at the deadline, and not when it dipped inside the window', async () => {
      const slices: Record<string, object> = { [KEY]: { power: 2000 } }
      const h = start(await load(power({})), { slices })
      await settle()
      put(slices, 3500)
      wake(h, { power: 3500 })
      await settle(299_000)
      expect(h.mutate).not.toHaveBeenCalled()
      await settle(2_000)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      await settle(900_000)
      expect(h.mutate).toHaveBeenCalledTimes(1)
      h.stop()

      const slices2: Record<string, object> = { [KEY]: { power: 2000 } }
      const dip = start(await load(power({})), { slices: slices2 })
      await settle()
      put(slices2, 3500)
      wake(dip, { power: 3500 })
      await settle(150_000)
      put(slices2, 2900)
      wake(dip, { power: 2900 })
      await settle(60_000)
      put(slices2, 3500)
      wake(dip, { power: 3500 })
      await settle(299_000)
      expect(dip.mutate).not.toHaveBeenCalled()
    })

    it('already held when the block starts: it does not fire for that episode', async () => {
      const slices: Record<string, object> = { [KEY]: { power: 3500 } }
      const h = start(await load(power({})), { slices })
      await settle(900_000)
      expect(h.mutate).not.toHaveBeenCalled()
    })

    it('in a guard: a step runs only once the value has held for the window', async () => {
      const slices: Record<string, object> = { [KEY]: { power: 2000 } }
      const guarded: RecipeInput = {
        when: MOTION,
        actions: [
          {
            ...SIREN,
            if: {
              kind: 'device-is',
              deviceId: 9,
              cap: 'meter',
              fieldPath: 'power',
              operator: 'gt',
              value: 3000,
              for: { ms: 60_000, mode: 'held' },
            },
          },
        ],
      } as RecipeInput
      const h = start(await load(guarded), { slices })
      await settle()
      put(slices, 3500)
      wake(h, { power: 3500 })
      await settle(30_000)
      h.emit('motion.on-motion-changed', {}, 616)
      await settle(1_000)
      expect(h.mutate).not.toHaveBeenCalled()
      await settle(40_000)
      h.emit('motion.on-motion-changed', {}, 616)
      await settle(1_000)
      expect(h.mutate).toHaveBeenCalledTimes(1)
    })
  })
})
