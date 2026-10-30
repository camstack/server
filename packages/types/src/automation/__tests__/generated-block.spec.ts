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

async function load(input: RecipeInput, name = 'Test automation'): Promise<BlockFn> {
  const source = generateAutomationBlock({ name, recipe: AutomationRecipeSchema.parse(input) })
  const bundled = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: HERE, sourcefile: 'generated.ts' },
    alias: { '@camstack/types': SHIM },
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
  readonly failSliceReads?: boolean
  readonly ledger?: Ledger
  /** The hub cannot answer the stamp read. */
  readonly failStampRead?: boolean
  /** What `actions.run` answers. */
  readonly actionOutcome?: { outcome: string; message?: string }
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
      deviceManager: { listAll: { query: async () => ({ devices: [] }) } },
      siren: { on: { mutate } },
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
    const h = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices: { '3|contact': { open: true }, '5|switch': { on: true } } },
    )
    await settle()
    lightEvent(h)
    await settle()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(h.traces()[0]).toMatchObject({ outcome: 'ran', trigger: { kind: 'device-becomes' } })
    expect(h.traces()[0]?.trigger.vars).toMatchObject({ deviceId: 5 })
  })

  it('rule 1: the same event with the state false does not fire, and says which row failed', async () => {
    const h = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices: { '3|contact': { open: false }, '5|switch': { on: true } } },
    )
    await settle()
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
    const slices = { '3|contact': { open: true }, '5|switch': { on: true } }
    const a = start(
      await load({ when: { kind: 'all', children: [lightOn, doorOpenNow] }, actions: [SIREN] }),
      { slices },
    )
    const b = start(
      await load({ when: { kind: 'all', children: [doorOpens, lightOnNow] }, actions: [SIREN] }),
      { slices },
    )
    await settle()
    doorEvent(a)
    doorEvent(b)
    await settle(5_000)
    // The door event is the instant for B, and only a state for A.
    expect(a.mutate).not.toHaveBeenCalled()
    expect(b.mutate).toHaveBeenCalledTimes(1)
    expect(b.traces()[0]?.trigger.vars).toMatchObject({ deviceId: 3 })
    lightEvent(a)
    lightEvent(b)
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
