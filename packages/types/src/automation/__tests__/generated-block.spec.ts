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
import type { AutomationRecipe } from '../recipe.js'
import { AutomationStateDocSchema, type AutomationRunTrace } from '../trace.js'

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
  readonly files: Map<string, Buffer>
  readonly sliceReads: { count: number }
  emit(category: string, data: Record<string, unknown>, deviceId?: number): void
  traces(): AutomationRunTrace[]
  stop(): void
}

type BlockFn = (ctx: unknown) => () => void

const workDir = mkdtempSync(path.join(tmpdir(), 'camstack-generated-block-'))
let seq = 0

async function load(recipe: AutomationRecipe, name = 'Test automation'): Promise<BlockFn> {
  const source = generateAutomationBlock({ name, recipe })
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
  readonly files?: Map<string, Buffer>
}

function start(block: BlockFn, options: Options = {}): Harness {
  const logs: LogLine[] = []
  const handlers: Array<{ category: string; handler: Handler }> = []
  const files = options.files ?? new Map<string, Buffer>()
  const sliceReads = { count: 0 }
  const mutate = vi.fn(async () => undefined)
  const log = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    logs.push({ level, msg, meta })
  }
  const ctx = {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    eventBus: {
      subscribe: (filter: { category: string }, handler: Handler) => {
        const entry = { category: filter.category, handler }
        handlers.push(entry)
        return () => {
          handlers.splice(handlers.indexOf(entry), 1)
        }
      },
    },
    storage: {
      exists: async (w: { relativePath: string }) => files.has(w.relativePath),
      read: async (w: { relativePath: string }) => files.get(w.relativePath) ?? Buffer.alloc(0),
      write: async (w: { relativePath: string; data: Buffer }) => {
        files.set(w.relativePath, w.data)
      },
    },
    api: {
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
    files,
    sliceReads,
    emit: (category, data, deviceId) => {
      for (const h of [...handlers]) {
        if (h.category === category) h.handler({ category, deviceId, data })
      }
    },
    traces: () => {
      const raw = [...files.values()][0]
      return raw === undefined
        ? []
        : AutomationStateDocSchema.parse(JSON.parse(raw.toString('utf8'))).traces
    },
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

  it('cooldown survives a restart: a new block reads the stamp from ctx.storage', async () => {
    const recipe: AutomationRecipe = {
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
    const second = start(block, { files: first.files })
    await settle()
    second.emit('motion.on-motion-changed', {})
    await settle()
    expect(second.mutate).not.toHaveBeenCalled()
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
    triggers: [MOTION],
    actions: [SIREN],
    conditions: {
      kind: 'condition',
      deviceId: 3,
      cap: 'sensor',
      fieldPath: 'bowl',
      operator: 'gte',
      value: 5,
    },
  }

  it('unknown mirror value => false, logged with the device tag, traced with its reason', async () => {
    const h = start(await load(gate), { failSliceReads: true })
    await settle()
    h.emit('motion.on-motion-changed', {})
    await settle()
    expect(h.mutate).not.toHaveBeenCalled()
    const t = h.traces()[0]
    expect(t).toMatchObject({ outcome: 'skipped-conditions' })
    expect(t?.conditions[0]).toMatchObject({
      path: 'conditions',
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
    expect(h.traces()[0]?.conditions[0]).toMatchObject({
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

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})
