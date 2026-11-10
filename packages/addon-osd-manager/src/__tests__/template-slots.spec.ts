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
    get: async () => stored.get(deviceId) ?? EMPTY_BINDINGS,
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
    templates: { get: async () => [template], set: async () => undefined },
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
