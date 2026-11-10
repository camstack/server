/**
 * A slot's text is a device-template (D1021/D1025) rendered by the hub's one
 * renderer; the manager re-renders it when a device it reads changes, throttled.
 */
import type {
  DeviceTemplateRender,
  DeviceTemplateThisDevice,
  IScopedLogger,
  OsdNamedTemplate,
  OsdSlotBinding,
  OsdStatus,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_BINDINGS, type BindingsHandle, type OsdDeviceBindings } from '../bindings-store.js'
import type { BoundIndexHandle } from '../bound-index.js'
import {
  CLOCK_RERENDER_MS,
  OsdManager,
  type OsdManagerDeps,
  DEPENDENCY_CACHE_MAX,
  SLOT_RERENDER_THROTTLE_MS,
} from '../osd-manager.js'
import type { OsdTemplateCheck } from '../template-context.js'

const CAMERA = 101
const SENSOR = 7
const OTHER = 8

const STATUS: OsdStatus = {
  overlays: [{ id: 'text-1', kind: 'text', enabled: true, text: '', availablePositions: [] }],
}

interface LogLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string, ctx?: { tags?: Record<string, unknown> }): void => {
      lines.push({ level, message, tags: ctx?.tags })
    }
  const self: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => self,
    withTags: () => self,
  }
  return self
}

const TEMPLATE: OsdNamedTemplate = {
  id: 'tpl',
  name: 'Temperature',
  text: '{{ garage.temperature }}',
}
const BINDING: OsdSlotBinding = {
  enabled: true,
  source: { kind: 'template', templateId: 'tpl' },
}

interface Harness {
  readonly manager: OsdManager
  readonly writes: string[]
  readonly renders: Array<{ templates: readonly string[]; thisDevice: DeviceTemplateThisDevice }>
  readonly checks: number[]
  readonly logs: LogLine[]
  readonly stored: Map<number, OsdDeviceBindings>
  /** How many times a camera's bindings were read: work a forgotten slot must not cause. */
  reads: number
  templates: OsdNamedTemplate[]
  next: DeviceTemplateRender
  check: OsdTemplateCheck
}

function makeHarness(options: { readonly text?: string } = {}): Harness {
  const writes: string[] = []
  const renders: Harness['renders'] = []
  const checks: number[] = []
  const logs: LogLine[] = []
  const template: OsdNamedTemplate = { ...TEMPLATE, text: options.text ?? TEMPLATE.text }
  const stored = new Map<number, OsdDeviceBindings>([[CAMERA, { 'text-1': BINDING }]])
  const bindings = (deviceId: number): BindingsHandle => ({
    get: async () => {
      harness.reads += 1
      return stored.get(deviceId) ?? EMPTY_BINDINGS
    },
    set: async (next) => {
      stored.set(deviceId, next)
    },
    update: async (fn) => {
      stored.set(deviceId, fn(stored.get(deviceId) ?? EMPTY_BINDINGS))
    },
  })
  let index: number[] | null = [CAMERA]
  const boundIndex: BoundIndexHandle = {
    get: async () => index,
    set: async (value) => {
      index = value === null ? null : [...value]
    },
  }
  const harness: Harness = {
    manager: undefined as never,
    writes,
    renders,
    checks,
    logs,
    stored,
    reads: 0,
    templates: [template],
    next: { ok: true, text: '21°C', trace: [] },
    check: {
      ok: true,
      readsClock: false,
      aliases: [{ alias: 'garage', deviceId: SENSOR }],
    },
  }
  const deps: OsdManagerDeps = {
    logger: recordingLogger(logs),
    readOsdStatus: async () => STATUS,
    writeOverlay: async (_deviceId, _overlayId, patch) => {
      if (patch.text !== undefined) writes.push(patch.text)
    },
    readDeviceSnapshot: async () => ({}),
    listCameras: async () => [{ id: CAMERA, name: 'Gate' }],
    readLatestRecognitions: async () => ({ person: { text: 'Anna', atMs: 1 } }),
    renderTemplates: async (input) => {
      renders.push(input)
      return input.templates.map(() => harness.next)
    },
    checkTemplates: async (input) => {
      checks.push(input.templates.length)
      return input.templates.map(() => harness.check)
    },
    bindings,
    boundIndex,
    templates: { get: async () => harness.templates, set: async () => undefined },
    now: () => Date.now(),
  }
  return Object.assign(harness, { manager: new OsdManager(deps) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 10, 9, 5, 20))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a template slot (BYS #450 P5)', () => {
  it('renders through the hub and writes the text, handing over the camera and the recognitions', async () => {
    const h = makeHarness({ text: '{{ camera.lastPerson }} {{ garage.temperature }}' })
    await h.manager.renderDevice({ deviceId: CAMERA })

    expect(h.writes).toEqual(['21°C'])
    expect(h.renders[0]?.templates).toEqual(['{{ camera.lastPerson }} {{ garage.temperature }}'])
    expect(h.renders[0]?.thisDevice).toEqual({
      deviceId: CAMERA,
      values: { lastPerson: 'Anna', lastPlate: '' },
    })
  })

  it('a refused render keeps the last good text and logs once per reason, tagged with the camera', async () => {
    const h = makeHarness()
    await h.manager.renderDevice({ deviceId: CAMERA })
    expect(h.writes).toEqual(['21°C'])

    h.next = { ok: false, refusal: { reason: 'timeout', message: 'too slow' }, trace: [] }
    const first = await h.manager.renderDevice({ deviceId: CAMERA })
    const second = await h.manager.renderDevice({ deviceId: CAMERA })

    expect(first.results[0]?.outcome).toBe('unreadable')
    expect(first.results[0]?.text).toBe('21°C')
    expect(second.results[0]?.outcome).toBe('unreadable')
    expect(h.writes).toEqual(['21°C'])
    const refusals = h.logs.filter((l) => l.level === 'warn' && l.message.includes('refused'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.tags).toEqual({ deviceId: CAMERA })
  })

  it('a value that rendered as an unavailable marker is unreadable, not text for the camera', async () => {
    const h = makeHarness()
    h.next = { ok: true, text: '—', trace: [{ ref: 'garage.temperature', reason: 'unavailable' }] }
    const out = await h.manager.renderDevice({ deviceId: CAMERA })

    expect(out.results[0]?.outcome).toBe('unreadable')
    expect(out.results[0]?.reason).toContain('garage.temperature')
    expect(h.writes).toEqual([])
  })
})

describe('re-render on the devices a template reads', () => {
  it('re-renders on a change of a watched device and ignores any other', async () => {
    const h = makeHarness()
    await h.manager.renderDevice({ deviceId: CAMERA })
    const before = h.renders.length
    expect(h.checks.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS)
    h.next = { ok: true, text: '22°C', trace: [] }
    h.manager.onDeviceStateChanged(OTHER)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.renders.length).toBe(before)

    h.manager.onDeviceStateChanged(SENSOR)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.renders.length).toBe(before + 1)
    expect(h.writes).toEqual(['21°C', '22°C'])
  })

  it('throttles a burst per slot: one render now, one trailing render at the window end', async () => {
    const h = makeHarness()
    await h.manager.renderDevice({ deviceId: CAMERA })
    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS)
    const before = h.renders.length

    for (let i = 0; i < 5; i += 1) h.manager.onDeviceStateChanged(SENSOR)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.renders.length).toBe(before + 1)

    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS - 1)
    expect(h.renders.length).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.renders.length).toBe(before + 2)

    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS * 3)
    expect(h.renders.length).toBe(before + 2)
  })

  it('re-renders a template that reads the clock on the minute', async () => {
    const h = makeHarness({ text: "{{ now | time('HH:mm') }}" })
    h.check = { ok: true, readsClock: true, aliases: [] }
    await h.manager.start(10 * 60_000)
    await h.manager.settleReconcile()
    await vi.advanceTimersByTimeAsync(0)
    const before = h.renders.length

    // 09:05:20 → the next minute boundary is 40 s away.
    await vi.advanceTimersByTimeAsync(39_000)
    expect(h.renders.length).toBe(before)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.renders.length).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(CLOCK_RERENDER_MS)
    expect(h.renders.length).toBe(before + 2)
    h.manager.stop()
  })
})

describe('what the event path remembers is let go with the slot', () => {
  async function startedClock(): Promise<Harness> {
    const h = makeHarness({ text: "{{ now | time('HH:mm') }}" })
    h.check = { ok: true, readsClock: true, aliases: [] }
    await h.manager.start(10 * 60_000)
    await h.manager.settleReconcile()
    await vi.advanceTimersByTimeAsync(0)
    return h
  }

  it('a cleared clock slot stops ticking', async () => {
    const h = await startedClock()
    await vi.advanceTimersByTimeAsync(41_000)
    const ticking = h.renders.length
    await vi.advanceTimersByTimeAsync(CLOCK_RERENDER_MS)
    expect(h.renders.length).toBe(ticking + 1)

    await h.manager.clearSlotBinding({ deviceId: CAMERA, slotId: 'text-1' })
    const readsAfterClear = h.reads
    await vi.advanceTimersByTimeAsync(CLOCK_RERENDER_MS * 3)
    // A slot still on the clock list would read the camera's bindings again at every minute.
    expect(h.reads).toBe(readsAfterClear)
    h.manager.stop()
  })

  it('a slot a rewrite of the bindings dropped no longer wakes on its device', async () => {
    const h = makeHarness()
    await h.manager.renderDevice({ deviceId: CAMERA })
    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS)
    h.stored.set(CAMERA, {})
    await h.manager.renderDevice({ deviceId: CAMERA })
    const readsBefore = h.reads

    h.manager.onDeviceStateChanged(SENSOR)
    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS * 2)
    expect(h.reads).toBe(readsBefore)
  })

  it('a slot whose template was deleted stops waking on the next pass', async () => {
    const h = makeHarness()
    await h.manager.renderDevice({ deviceId: CAMERA })
    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS)
    h.templates = []
    await h.manager.deleteTemplate({ templateId: 'tpl' })
    await h.manager.renderDevice({ deviceId: CAMERA })
    const readsBefore = h.reads

    h.manager.onDeviceStateChanged(SENSOR)
    await vi.advanceTimersByTimeAsync(SLOT_RERENDER_THROTTLE_MS * 2)
    expect(h.reads).toBe(readsBefore)
  })

  it('keeps the dependency answers to a bounded number', async () => {
    const h = makeHarness()
    const many = DEPENDENCY_CACHE_MAX + 40
    h.templates = Array.from({ length: many }, (_, i) => ({
      id: `t${i}`,
      name: `T${i}`,
      text: `{{ garage.v${i} }}`,
    }))
    h.stored.set(
      CAMERA,
      Object.fromEntries(
        h.templates.map(
          (t, i) =>
            [
              `text-${i}`,
              { enabled: true, source: { kind: 'template', templateId: t.id } },
            ] as const,
        ),
      ),
    )
    await h.manager.renderDevice({ deviceId: CAMERA })
    const first = h.checks.reduce((sum, n) => sum + n, 0)
    expect(first).toBe(many)
    await h.manager.renderDevice({ deviceId: CAMERA })
    // Unbounded, every answer would still be cached and the second pass would ask nothing.
    expect(h.checks.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(first)
  })
})
