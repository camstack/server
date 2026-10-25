import {
  type IScopedLogger,
  type OsdSlotBinding,
  OsdSlotBindingSchema,
  type OsdStatus,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BindingsHandle, OsdDeviceBindings } from '../bindings-store.js'
import { EMPTY_TEMPLATES } from '../templates-store.js'
import { EMPTY_BINDINGS } from '../bindings-store.js'
import type { BoundIndexHandle, OsdBoundIndex } from '../bound-index.js'
import { OsdManager, type OsdManagerDeps } from '../osd-manager.js'

const CAMERA = 101
const AT = Date.UTC(2026, 7, 7, 9, 5, 0)

const STATUS: OsdStatus = {
  overlays: [
    {
      id: 'dateTime',
      kind: 'timestamp',
      enabled: true,
      availablePositions: [],
      readOnly: true,
    },
    {
      id: 'text-1',
      kind: 'text',
      enabled: false,
      text: '',
      availablePositions: [],
    },
    {
      id: 'text-2',
      kind: 'text',
      enabled: false,
      text: '',
      availablePositions: [],
    },
  ],
}

/** A complete `IScopedLogger` — no cast, so a widened interface breaks here. */
function noopLogger(): IScopedLogger {
  const self: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => self,
    withTags: () => self,
  }
  return self
}

interface Harness {
  readonly manager: OsdManager
  readonly writes: Array<{
    deviceId: number
    overlayId: string
    enabled?: boolean
    text?: string
  }>
  readonly stored: Map<number, OsdDeviceBindings>
  /**
   * Mutable device-state mirror. A Map, not a plain field on the returned
   * object: an earlier version returned `{ ...harness }` and the copy meant
   * every state change in a test was invisible to the manager, which made
   * the change-detection test pass for the wrong reason.
   */
  readonly snapshot: Map<number, Record<string, unknown>>
}

function makeHarness(overrides: Partial<OsdManagerDeps> = {}): Harness {
  const writes: Harness['writes'] = []
  const stored = new Map<number, OsdDeviceBindings>()
  const snapshot = new Map<number, Record<string, unknown>>()

  const bindings = (deviceId: number): BindingsHandle => ({
    get: async () => stored.get(deviceId) ?? EMPTY_BINDINGS,
    set: async (next) => {
      stored.set(deviceId, next)
    },
    update: async (fn) => {
      stored.set(deviceId, fn(stored.get(deviceId) ?? EMPTY_BINDINGS))
    },
  })

  // The durable work list, in memory. These specs are about rendering, not
  // about the index — `bound-index.spec.ts` owns that.
  let boundIndexValue: OsdBoundIndex = null
  const boundIndex: BoundIndexHandle = {
    get: async () => boundIndexValue,
    set: async (next) => {
      boundIndexValue = next === null ? null : [...next]
    },
  }

  const manager = new OsdManager({
    logger: noopLogger(),
    readOsdStatus: async (deviceId) => (deviceId === CAMERA ? STATUS : null),
    writeOverlay: async (deviceId, overlayId, patch) => {
      writes.push({ deviceId, overlayId, ...patch })
    },
    readDeviceSnapshot: async (deviceId) => snapshot.get(deviceId) ?? {},
    listDevices: async () => [{ id: CAMERA, name: 'Gate' }],
    listCameras: async () => [{ id: CAMERA, name: 'Gate' }],
    listDeviceCapsBatch: async (deviceIds) => new Map(deviceIds.map((id) => [id, ['motion']])),
    readLatestRecognitions: async () => ({}),
    bindings,
    boundIndex,
    templates: {
      get: async () => EMPTY_TEMPLATES,
      set: async () => undefined,
    },
    now: () => AT,
    ...overrides,
  })

  return { manager, writes, stored, snapshot }
}

function binding(patch: Partial<OsdSlotBinding>): OsdSlotBinding {
  return OsdSlotBindingSchema.parse({
    source: { kind: 'static', text: '' },
    ...patch,
  })
}

describe('OsdManager.getDeviceOsd', () => {
  it('reports unsupported for a camera with no osd cap, rather than an empty slot list', async () => {
    const h = makeHarness()
    expect(await h.manager.getDeviceOsd({ deviceId: 999 })).toEqual({
      supported: false,
      slots: [],
    })
  })

  it('pairs every firmware slot with its binding', async () => {
    const h = makeHarness()
    const view = await h.manager.getDeviceOsd({ deviceId: CAMERA })
    expect(view.supported).toBe(true)
    expect(view.slots.map((s) => s.slotId)).toEqual(['dateTime', 'text-1', 'text-2'])
    expect(view.slots[0]).toMatchObject({ readOnly: true, binding: null })
  })
})

describe('OsdManager.setSlotBinding', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  describe('OsdManager.copyDeviceConfiguration', () => {
    it('maps configured writable slots by ordinal and drops legacy camera scope', async () => {
      const target = 616
      const targetStatus: OsdStatus = {
        overlays: [
          {
            id: 'clock',
            kind: 'timestamp',
            enabled: true,
            availablePositions: [],
            readOnly: true,
          },
          {
            id: 'overlay-a',
            kind: 'text',
            enabled: false,
            text: '',
            availablePositions: [],
          },
        ],
      }
      const h = makeHarness({
        readOsdStatus: async (deviceId) => {
          if (deviceId === CAMERA) return STATUS
          if (deviceId === target) return targetStatus
          return null
        },
      })
      h.stored.set(CAMERA, {
        'text-2': binding({
          source: { kind: 'latest-recognition', recognition: 'person' },
          conditions: { devices: [CAMERA] },
        }),
      })

      const result = await h.manager.copyDeviceConfiguration({
        sourceDeviceId: CAMERA,
        targetDeviceId: target,
      })

      expect(result).toEqual({ copied: 1, skipped: 0 })
      expect(h.stored.get(target)?.['overlay-a']).toMatchObject({
        source: { kind: 'latest-recognition', recognition: 'person' },
        conditions: undefined,
      })
      expect(h.writes[0]).toMatchObject({
        deviceId: target,
        overlayId: 'overlay-a',
      })
    })
  })

  it('persists, then writes the rendered text to the camera', async () => {
    const out = await h.manager.setSlotBinding({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: binding({
        source: { kind: 'static', text: 'GATE' },
        template: '${value}',
      }),
    })
    expect(out.render).toMatchObject({ outcome: 'written', text: 'GATE' })
    expect(h.writes).toEqual([{ deviceId: CAMERA, overlayId: 'text-1', text: 'GATE' }])
    expect(h.stored.get(CAMERA)?.['text-1']).toBeDefined()
  })

  it('refuses a slot the camera does not expose, naming the slots that exist', async () => {
    await expect(
      h.manager.setSlotBinding({
        deviceId: CAMERA,
        slotId: 'text-9',
        binding: binding({ source: { kind: 'static', text: 'X' } }),
      }),
    ).rejects.toThrow(/text-1/)
    expect(h.writes).toHaveLength(0)
  })

  it('refuses a firmware-owned slot instead of writing text it will drop', async () => {
    await expect(
      h.manager.setSlotBinding({
        deviceId: CAMERA,
        slotId: 'dateTime',
        binding: binding({ source: { kind: 'static', text: 'X' } }),
      }),
    ).rejects.toThrow(/firmware-owned/)
  })

  it('refuses a condition the overlay gate can never answer — BEFORE persisting', async () => {
    await expect(
      h.manager.setSlotBinding({
        deviceId: CAMERA,
        slotId: 'text-1',
        binding: binding({
          source: { kind: 'static', text: 'X' },
          conditions: { classes: ['person'] },
        }),
      }),
    ).rejects.toThrow(/classes/)
    expect(h.stored.get(CAMERA)).toBeUndefined()
  })
})

describe('OsdManager render loop', () => {
  it('writes ONCE for an unchanged value — the second pass is a no-op', async () => {
    const h = makeHarness()
    h.snapshot.set(CAMERA, { motion: { detected: true } })
    await h.manager.setSlotBinding({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: binding({
        source: {
          kind: 'device-state',
          capName: 'motion',
          valuePath: 'detected',
        },
        valueMap: { true: 'MOTION', false: '' },
        template: '${value}',
      }),
    })
    expect(h.writes).toHaveLength(1)

    const again = await h.manager.renderDevice({ deviceId: CAMERA })
    expect(again.results[0]).toMatchObject({ outcome: 'unchanged' })
    expect(h.writes).toHaveLength(1)

    // And it writes again the moment the value moves — proving the guard is
    // change detection and not a one-shot latch.
    h.snapshot.set(CAMERA, { motion: { detected: false } })
    const moved = await h.manager.renderDevice({ deviceId: CAMERA })
    expect(moved.results[0]).toMatchObject({ outcome: 'written', text: '' })
    expect(h.writes).toHaveLength(2)
    expect(h.writes[1]).toMatchObject({ text: '' })
    expect(h.writes[1]).not.toHaveProperty('enabled')
  })

  it('forgets the last-written text on a failed write so the next pass retries', async () => {
    let fail = true
    const h = makeHarness({
      writeOverlay: async () => {
        if (fail) throw new Error('camera refused')
      },
    })
    await expect(
      h.manager.setSlotBinding({
        deviceId: CAMERA,
        slotId: 'text-1',
        binding: binding({
          source: { kind: 'static', text: 'GATE' },
          template: '${value}',
        }),
      }),
    ).resolves.toMatchObject({ render: { outcome: 'failed' } })

    fail = false
    const retry = await h.manager.renderDevice({ deviceId: CAMERA })
    expect(retry.results[0]).toMatchObject({
      outcome: 'written',
      text: 'GATE',
    })
  })

  it('clearing a binding stops the loop from driving that camera', async () => {
    const h = makeHarness()
    await h.manager.setSlotBinding({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: binding({ source: { kind: 'static', text: 'GATE' } }),
    })
    await h.manager.clearSlotBinding({ deviceId: CAMERA, slotId: 'text-1' })
    const after = await h.manager.renderDevice({ deviceId: CAMERA })
    expect(after.results).toEqual([])
  })
})

describe('OsdManager.previewSlot', () => {
  it('never writes, and never reports unchanged', async () => {
    const h = makeHarness()
    const b = binding({
      source: { kind: 'static', text: 'GATE' },
      template: '${value}',
    })
    await h.manager.setSlotBinding({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: b,
    })
    const writesAfterSave = h.writes.length

    const preview = await h.manager.previewSlot({
      deviceId: CAMERA,
      slotId: 'text-1',
    })
    expect(preview).toMatchObject({ outcome: 'written', text: 'GATE' })
    expect(h.writes).toHaveLength(writesAfterSave)
  })

  it('previews an unsaved binding without touching the stored one', async () => {
    const h = makeHarness()
    const preview = await h.manager.previewSlot({
      deviceId: CAMERA,
      slotId: 'text-2',
      binding: binding({
        source: { kind: 'clock', pattern: 'HH:mm', timezone: 'UTC' },
      }),
    })
    expect(preview.text).toBe('09:05')
    expect(h.stored.get(CAMERA)).toBeUndefined()
  })

  it('hydrates the latest recognized person and plate from persisted tracks', async () => {
    const h = makeHarness({
      readLatestRecognitions: async () => ({
        person: { text: 'Alice', atMs: AT },
        plate: { text: 'AB123CD', atMs: AT - 1_000 },
      }),
    })

    const person = await h.manager.previewSlot({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: binding({
        source: { kind: 'latest-recognition', recognition: 'person' },
      }),
    })
    const plate = await h.manager.previewSlot({
      deviceId: CAMERA,
      slotId: 'text-2',
      binding: binding({
        source: { kind: 'latest-recognition', recognition: 'plate' },
      }),
    })

    expect(person.text).toBe('Alice')
    expect(plate.text).toBe('AB123CD')
  })

  it('advances recognition values from live lifecycle events', async () => {
    const h = makeHarness()
    h.manager.onTrackLifecycle({
      deviceId: CAMERA,
      trackId: 'live-person',
      phase: 'update',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.92,
      label: 'Alice',
      firstSeen: AT,
      lastSeen: AT + 1_000,
      durationMs: 1_000,
    })

    const preview = await h.manager.previewSlot({
      deviceId: CAMERA,
      slotId: 'text-1',
      binding: binding({
        source: { kind: 'latest-recognition', recognition: 'person' },
      }),
    })
    expect(preview.text).toBe('Alice')
  })

  it('re-hydrates corrected and deleted gallery values authoritatively', async () => {
    let latest: { person?: { text: string; atMs: number } } = {
      person: { text: 'Alice', atMs: AT },
    }
    const h = makeHarness({
      readLatestRecognitions: async () => latest,
    })
    const personBinding = binding({
      source: { kind: 'latest-recognition', recognition: 'person' },
    })

    expect(
      await h.manager.previewSlot({
        deviceId: CAMERA,
        slotId: 'text-1',
        binding: personBinding,
      }),
    ).toMatchObject({ text: 'Alice' })

    latest = { person: { text: 'Bob', atMs: AT } }
    h.manager.onRecognitionGalleryChanged(CAMERA)
    expect(
      await h.manager.previewSlot({
        deviceId: CAMERA,
        slotId: 'text-1',
        binding: personBinding,
      }),
    ).toMatchObject({ text: 'Bob' })

    latest = {}
    h.manager.onRecognitionGalleryChanged(CAMERA)
    h.manager.onTrackLifecycle({
      deviceId: CAMERA,
      trackId: 'pre-invalidation-person',
      phase: 'update',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.92,
      label: 'Bob',
      firstSeen: AT - 1_000,
      lastSeen: AT + 1_000,
      durationMs: 2_000,
    })
    expect(
      await h.manager.previewSlot({
        deviceId: CAMERA,
        slotId: 'text-1',
        binding: personBinding,
      }),
    ).toMatchObject({ outcome: 'unreadable', text: '' })
  })
})

describe('OsdManager.getConditionSupport', () => {
  it('returns the supported ids alongside the full shared catalog', async () => {
    const h = makeHarness()
    const out = await h.manager.getConditionSupport()
    expect(out.supported).toContain('deviceState')
    expect(out.catalog.length).toBeGreaterThan(10)
  })
})
