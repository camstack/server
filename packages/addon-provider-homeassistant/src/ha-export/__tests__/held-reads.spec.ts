import { describe, expect, it } from 'vitest'
import { ReadMirror, cameraFunctionReadsFailed, type ReadOutcome } from '../held-reads.js'
import type { CameraFunctionReads } from '../camera-functions.js'

interface Item {
  readonly id: string
  readonly label: string
}
const item = (id: string, label = id): Item => ({ id, label })
const answered = (...items: Item[]): ReadOutcome<Item> => ({
  kind: 'answered',
  items,
})
const failed = (reason: string): ReadOutcome<Item> => ({
  kind: 'failed',
  reason,
})
const newMirror = (): ReadMirror<Item> => new ReadMirror<Item>((i) => i.id)

describe('ReadMirror', () => {
  it('accepts the first answered read, even an empty one', () => {
    const m = newMirror()
    expect(m.resolve(1, answered())).toEqual({ status: 'fresh', items: [] })
  })

  it('a FAILED read keeps the last exported set instead of announcing a smaller one', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a'), item('b')))
    const r = m.resolve(1, failed('no provider registered for cap "webrtc-session"'))
    expect(r.status).toBe('held-failed')
    expect(r.status !== 'unknown' && r.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(r.status === 'held-failed' && r.reason).toContain('webrtc-session')
  })

  it('a failed read with NOTHING held is unknown, never an empty answer', () => {
    const m = newMirror()
    expect(m.resolve(1, failed('boot')).status).toBe('unknown')
  })

  it('an answered read that DROPS an item needs a second agreeing answer', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a'), item('b')))
    const first = m.resolve(1, answered(item('a')))
    expect(first.status).toBe('held-removal')
    expect(first.status !== 'unknown' && first.items.map((i) => i.id)).toEqual(['a', 'b'])
    const second = m.resolve(1, answered(item('a')))
    expect(second).toEqual({ status: 'fresh', items: [item('a')] })
  })

  it('a removal that is contradicted by the next read is not applied', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a'), item('b')))
    m.resolve(1, answered(item('a')))
    const back = m.resolve(1, answered(item('a'), item('b')))
    expect(back.status).toBe('fresh')
    // and the pending removal is forgotten: one more shrink is again only a first vote
    expect(m.resolve(1, answered(item('a'))).status).toBe('held-removal')
  })

  it('a failure between the two removal votes does not count as a vote', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a'), item('b')))
    m.resolve(1, answered(item('a')))
    expect(m.resolve(1, failed('x')).status).toBe('held-failed')
    expect(m.resolve(1, answered(item('a'))).status).toBe('fresh')
  })

  it('additions and relabels are applied at once', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a')))
    expect(m.resolve(1, answered(item('a', 'renamed'), item('c')))).toEqual({
      status: 'fresh',
      items: [item('a', 'renamed'), item('c')],
    })
  })

  it('keeps devices apart', () => {
    const m = newMirror()
    m.resolve(1, answered(item('a')))
    expect(m.resolve(2, failed('x')).status).toBe('unknown')
  })
})

describe('cameraFunctionReadsFailed', () => {
  const ok: CameraFunctionReads = {
    deviceDisabled: false,
    bindableCapNames: ['x'],
    wrappedCapNames: [],
    wrapperAddonIdByCap: new Map(),
    recordingEnabled: true,
    notificationsMuted: false,
    privacy: null,
    brokerAudioMuted: false,
  }
  it('is clean when every async source answered', () => {
    expect(cameraFunctionReadsFailed(ok, 'hub')).toBeNull()
  })
  it('names a source that did not answer', () => {
    expect(cameraFunctionReadsFailed({ ...ok, recordingEnabled: null }, 'hub')).toContain(
      'recordingEnabled',
    )
    expect(cameraFunctionReadsFailed({ ...ok, wrappedCapNames: null }, 'hub')).toContain(
      'wrappedCapNames',
    )
  })
  it('a camera with no source node has no broker-audio read to fail', () => {
    expect(cameraFunctionReadsFailed({ ...ok, brokerAudioMuted: null }, null)).toBeNull()
    expect(cameraFunctionReadsFailed({ ...ok, brokerAudioMuted: null }, 'hub')).toContain(
      'brokerAudioMuted',
    )
  })
})
