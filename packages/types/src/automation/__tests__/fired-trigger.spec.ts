import { describe, expect, it } from 'vitest'
import { DeviceFiredWatch, firedDataVars } from '../fired-trigger.js'
import type { DeviceFiredLeaf } from '../when.js'

const leaf: DeviceFiredLeaf = {
  kind: 'device-fired',
  deviceId: 40,
  sourceIds: ['3'],
  kinds: ['long-press'],
}

const VOCABULARY = [
  {
    id: 'PRESS_SHORT',
    source: { id: '3', label: 'Button 3' },
    label: 'Short press',
    kind: 'press',
  },
  {
    id: 'PRESS_LONG',
    source: { id: '3', label: 'Button 3' },
    label: 'Long press',
    kind: 'long-press',
  },
  {
    id: 'PRESS_LONG',
    source: { id: '4', label: 'Button 4' },
    label: 'Long press',
    kind: 'long-press',
  },
]

let seq = 0
const press = (over: Record<string, unknown> = {}) => ({
  deviceId: 40,
  eventType: 'PRESS_LONG',
  sourceId: '3',
  data: { channel: '3' },
  timestamp: 1_000 + (seq += 1),
  seq,
  ...over,
})

const status = (lastEvent: unknown, vocabulary: unknown = VOCABULARY) => ({
  eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
  vocabulary,
  lastEvent,
  eventCountSinceStart: 1,
})

function seeded(l: DeviceFiredLeaf = leaf): DeviceFiredWatch {
  const watch = new DeviceFiredWatch(l)
  watch.onStatus(status(null))
  return watch
}

describe('DeviceFiredWatch — the bus event', () => {
  it('fires for the wanted button and kind and exposes eventType, sourceId, eventKind and the payload', () => {
    const d = seeded().onEvent(press())
    expect(d.kind).toBe('fire')
    expect(d.kind === 'fire' && d.vars).toEqual({
      deviceId: 40,
      eventType: 'PRESS_LONG',
      sourceId: '3',
      eventKind: 'long-press',
    })
    expect(d.kind === 'fire' && d.data).toEqual({ 'data.channel': '3' })
  })

  it('two identical presses fire twice', () => {
    const watch = seeded()
    expect(watch.onEvent(press()).kind).toBe('fire')
    expect(watch.onEvent(press()).kind).toBe('fire')
  })

  it('the same fire delivered twice fires once', () => {
    const watch = seeded()
    const one = press()
    expect(watch.onEvent(one).kind).toBe('fire')
    expect(watch.onEvent(one).kind).toBe('ignore')
  })

  it('another button, another kind, another device and a malformed event do not fire', () => {
    const watch = seeded()
    expect(watch.onEvent(press({ sourceId: '4' })).kind).toBe('ignore')
    expect(watch.onEvent(press({ eventType: 'PRESS_SHORT' })).kind).toBe('ignore')
    expect(watch.onEvent(press({ deviceId: 41 })).kind).toBe('ignore')
    expect(watch.onEvent({ deviceId: 40 }).kind).toBe('ignore')
  })

  it('eventIds narrows by token; a leaf with no filter fires on every event of the device', () => {
    const byToken = seeded({ kind: 'device-fired', deviceId: 40, eventIds: ['PRESS_SHORT'] })
    expect(byToken.onEvent(press()).kind).toBe('ignore')
    expect(byToken.onEvent(press({ eventType: 'PRESS_SHORT' })).kind).toBe('fire')
    const open = seeded({ kind: 'device-fired', deviceId: 40 })
    expect(open.onEvent(press({ sourceId: '4' })).kind).toBe('fire')
    expect(open.onEvent(press({ sourceId: undefined, eventType: 'anything' })).kind).toBe('fire')
  })

  it('a fire with no source exposes an empty sourceId, and an undeclared token an empty kind', () => {
    const d = seeded({ kind: 'device-fired', deviceId: 40 }).onEvent(
      press({ sourceId: undefined, eventType: 'custom_thing', data: null }),
    )
    expect(d.kind === 'fire' && d.vars).toMatchObject({ sourceId: '', eventKind: '' })
    expect(d.kind === 'fire' && d.data).toEqual({})
  })

  it('match: every payload predicate must hold; a miss is rejected with a reason', () => {
    const watch = seeded({
      kind: 'device-fired',
      deviceId: 40,
      match: [{ path: 'scene.id', equals: 2 }],
    })
    expect(watch.onEvent(press({ data: { scene: { id: 2 } } })).kind).toBe('fire')
    const miss = watch.onEvent(press({ data: { scene: { id: 3 } } }))
    expect(miss.kind).toBe('reject')
    expect(miss.kind === 'reject' && miss.reason).toContain('scene.id')
    expect(watch.onEvent(press({ data: null })).kind).toBe('reject')
  })

  it('before the vocabulary was ever read, the kind comes from the token by convention', () => {
    const watch = new DeviceFiredWatch({
      kind: 'device-fired',
      deviceId: 40,
      kinds: ['long-press'],
    })
    expect(watch.onEvent(press({ eventType: 'long_press' })).kind).toBe('fire')
    expect(watch.onEvent(press({ eventType: 'PRESS_XYZ' })).kind).toBe('ignore')
  })
})

describe('DeviceFiredWatch — the reconcile read', () => {
  it('the first read seeds and never fires: a restart is not a press', () => {
    const watch = new DeviceFiredWatch(leaf)
    expect(watch.onStatus(status(press())).kind).toBe('ignore')
  })

  it('a newer lastEvent whose bus event never arrived fires once, said as recovered', () => {
    const watch = seeded()
    const lost = press()
    const d = watch.onStatus(status(lost))
    expect(d.kind).toBe('fire')
    expect(d.kind === 'fire' && d.reason).toContain('recovered by reconcile')
    expect(watch.onStatus(status(lost)).kind).toBe('ignore')
    expect(watch.onEvent(lost).kind).toBe('ignore')
  })

  it('a fire the bus already delivered is not fired again by the read', () => {
    const watch = seeded()
    const one = press()
    expect(watch.onEvent(one).kind).toBe('fire')
    expect(watch.onStatus(status(one)).kind).toBe('ignore')
  })

  it('an unreadable status changes nothing: the next good read still only seeds', () => {
    const watch = new DeviceFiredWatch(leaf)
    expect(watch.onStatus(undefined).kind).toBe('ignore')
    expect(watch.onStatus({ nope: true }).kind).toBe('ignore')
    expect(watch.onStatus(status(press())).kind).toBe('ignore')
  })

  it('a provider that restarted (seq back to 1, later clock) is newer, not older', () => {
    const watch = seeded()
    expect(watch.onEvent(press({ timestamp: 5_000, seq: 90 })).kind).toBe('fire')
    expect(watch.onStatus(status(press({ timestamp: 6_000, seq: 1 }))).kind).toBe('fire')
    expect(watch.onStatus(status(press({ timestamp: 4_000, seq: 200 }))).kind).toBe('ignore')
  })

  it('a recovered fire of another button does not fire, and is not offered again', () => {
    const watch = seeded()
    const other = press({ sourceId: '4' })
    expect(watch.onStatus(status(other)).kind).toBe('ignore')
    expect(watch.onStatus(status(other)).kind).toBe('ignore')
  })

  it('a status written before the vocabulary existed still recovers a fire', () => {
    const watch = new DeviceFiredWatch({
      kind: 'device-fired',
      deviceId: 40,
      eventIds: ['PRESS_LONG'],
    })
    const legacy = { eventTypes: ['PRESS_LONG'], lastEvent: null, eventCountSinceStart: 0 }
    watch.onStatus(legacy)
    expect(watch.onStatus({ ...legacy, lastEvent: press() }).kind).toBe('fire')
  })
})

describe('firedDataVars', () => {
  it('flattens scalars under data.<path> and leaves the rest out', () => {
    expect(firedDataVars({ a: 1, b: { c: 'x', d: [1] }, e: null, f: true })).toEqual({
      'data.a': 1,
      'data.b.c': 'x',
      'data.f': true,
    })
    expect(firedDataVars(null)).toEqual({})
  })
})
