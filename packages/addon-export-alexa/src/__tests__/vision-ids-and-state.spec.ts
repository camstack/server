/** R4 (D779): the derived identifiers and the per-camera Alexa-side state. */
import { describe, expect, it } from 'vitest'
import {
  eventIdentifierFor,
  hashedUuidV4,
  objectIdentifierFor,
  uuidV5,
} from '../vision/vision-ids.js'
import {
  MAX_INDEX,
  reportableVisionClasses,
  VISION_STATE_KEY,
  VisionStateStore,
} from '../vision/vision-state.js'

const NS = '6f1c2a54-1d0e-4c8b-9a52-0c3f7d2e9b11'

describe('vision ids', () => {
  it('uuidV5 matches the RFC 4122 test vector', () => {
    // DNS namespace, "www.example.com"
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    )
  })

  it('hashedUuidV4 is version 4, RFC variant, deterministic', () => {
    const a = hashedUuidV4(NS, 'x')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(hashedUuidV4(NS, 'x')).toBe(a)
    expect(hashedUuidV4(NS, 'y')).not.toBe(a)
  })

  it('ids are per camera, per track, and per hub namespace', () => {
    const other = 'a1b2c3d4-0000-4000-8000-000000000000'
    expect(objectIdentifierFor(NS, 1, 't')).not.toBe(objectIdentifierFor(NS, 2, 't'))
    expect(objectIdentifierFor(NS, 1, 't')).not.toBe(objectIdentifierFor(other, 1, 't'))
    expect(eventIdentifierFor(NS, 1, 't', 'person')).not.toBe(
      eventIdentifierFor(NS, 1, 't', 'package'),
    )
  })
})

function memoryStore() {
  const blobs = new Map<number, Record<string, unknown>>()
  let writes = 0
  const store = new VisionStateStore({
    read: async (id) => ({ ...blobs.get(id) }),
    write: async (id, patch) => {
      writes += 1
      blobs.set(id, { ...blobs.get(id), ...patch })
    },
  })
  return { store, blobs, writes: () => writes }
}

describe('VisionStateStore', () => {
  it('persists the class choice under its own key in the device store', async () => {
    const m = memoryStore()
    await m.store.setClasses(3, ['person'])
    expect(m.blobs.get(3)?.[VISION_STATE_KEY]).toMatchObject({ classes: ['person'] })
  })

  it('remember is idempotent: a re-read history costs no write', async () => {
    const m = memoryStore()
    const entry = { e: 'e1', t: 't1', c: 'person' as const, at: 1 }
    await m.store.remember(3, [entry])
    await m.store.remember(3, [entry])
    expect(m.writes()).toBe(1)
    expect(await m.store.lookup(3, 'e1')).toEqual(entry)
  })

  it('the index keeps only the newest entries', async () => {
    const m = memoryStore()
    const entries = Array.from({ length: MAX_INDEX + 5 }, (_, i) => ({
      e: `e${i}`,
      t: `t${i}`,
      c: 'person' as const,
      at: i,
    }))
    await m.store.remember(3, entries)
    expect(await m.store.lookup(3, 'e0')).toBeNull()
    expect(await m.store.lookup(3, `e${MAX_INDEX + 4}`)).not.toBeNull()
  })

  it('concurrent writes do not erase each other', async () => {
    const m = memoryStore()
    await Promise.all([
      m.store.setClasses(3, ['package']),
      m.store.hide(3, ['x']),
      m.store.remember(3, [{ e: 'e', t: 't', c: 'person', at: 1 }]),
    ])
    m.store.invalidate(3)
    const s = await m.store.get(3)
    expect(s.classes).toEqual(['package'])
    expect(s.hidden).toEqual(['x'])
    expect(s.index.map((e) => e.e)).toEqual(['e'])
  })

  it('reportable = declared, narrowed by the user choice when there is one', () => {
    expect(reportableVisionClasses(['person', 'package'], { index: [], hidden: [] })).toEqual([
      'person',
      'package',
    ])
    expect(
      reportableVisionClasses(['person'], {
        classes: ['person', 'package'],
        index: [],
        hidden: [],
      }),
    ).toEqual(['person'])
    expect(
      reportableVisionClasses(['person', 'package'], { classes: [], index: [], hidden: [] }),
    ).toEqual([])
  })
})
