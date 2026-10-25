import { describe, it, expect } from 'vitest'
import {
  canonicalDeviceFingerprint,
  diffExportTargets,
  resolveExportFingerprint,
  type DeviceExportShape,
  type ExportTargetEntry,
} from '../export-reconciler.js'

const shape = (
  deviceId: number,
  deviceType: string,
  features: readonly string[],
): DeviceExportShape => ({ deviceId, deviceType, features })

describe('canonicalDeviceFingerprint', () => {
  it('is deterministic for the same shape', () => {
    const s = shape(1, 'camera', ['pan-tilt-zoom', 'motion-trigger'])
    expect(canonicalDeviceFingerprint(s)).toBe(canonicalDeviceFingerprint(s))
  })

  it('returns a 64-char lowercase hex digest', () => {
    const fp = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger']))
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is independent of feature order', () => {
    const a = canonicalDeviceFingerprint(shape(1, 'camera', ['pan-tilt-zoom', 'motion-trigger']))
    const b = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger', 'pan-tilt-zoom']))
    expect(a).toBe(b)
  })

  it('de-duplicates repeated features before hashing', () => {
    const a = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger', 'motion-trigger']))
    const b = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger']))
    expect(a).toBe(b)
  })

  it('excludes deviceId — same shape, different id ⇒ same fingerprint', () => {
    const a = canonicalDeviceFingerprint(shape(1, 'camera', ['two-way-audio']))
    const b = canonicalDeviceFingerprint(shape(999, 'camera', ['two-way-audio']))
    expect(a).toBe(b)
  })

  it('includes deviceType — different type ⇒ different fingerprint', () => {
    const a = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger']))
    const b = canonicalDeviceFingerprint(shape(1, 'battery-camera', ['motion-trigger']))
    expect(a).not.toBe(b)
  })

  it('changes when the feature set changes', () => {
    const a = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger']))
    const b = canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger', 'doorbell-button']))
    expect(a).not.toBe(b)
  })

  it('treats an empty feature set as a stable, distinct shape', () => {
    const empty = canonicalDeviceFingerprint(shape(1, 'camera', []))
    expect(empty).toMatch(/^[0-9a-f]{64}$/)
    expect(empty).not.toBe(canonicalDeviceFingerprint(shape(1, 'camera', ['motion-trigger'])))
  })
})

interface Desired {
  readonly deviceId: number
  readonly fingerprint: string
}

const lastMap = (
  entries: readonly (readonly [number, ExportTargetEntry])[],
): ReadonlyMap<number, ExportTargetEntry> => new Map(entries)

describe('diffExportTargets', () => {
  it('returns empty deltas for empty desired and empty last-advertised', () => {
    const delta = diffExportTargets<Desired>([], lastMap([]))
    expect(delta).toEqual({ toAdd: [], toUpdate: [], toRemove: [] })
  })

  it('classifies a device with no last-advertised entry as toAdd', () => {
    const desired: Desired[] = [{ deviceId: 1, fingerprint: 'aaa' }]
    const delta = diffExportTargets(desired, lastMap([]))
    expect(delta.toAdd).toEqual(desired)
    expect(delta.toUpdate).toEqual([])
    expect(delta.toRemove).toEqual([])
  })

  it('emits no delta when the fingerprint is unchanged', () => {
    const desired: Desired[] = [{ deviceId: 1, fingerprint: 'aaa' }]
    const last = lastMap([[1, { fingerprint: 'aaa', externalIds: ['ep-1'] }]])
    const delta = diffExportTargets(desired, last)
    expect(delta).toEqual({ toAdd: [], toUpdate: [], toRemove: [] })
  })

  it('classifies a changed fingerprint as toUpdate', () => {
    const desired: Desired[] = [{ deviceId: 1, fingerprint: 'bbb' }]
    const last = lastMap([[1, { fingerprint: 'aaa', externalIds: ['ep-1'] }]])
    const delta = diffExportTargets(desired, last)
    expect(delta.toUpdate).toEqual(desired)
    expect(delta.toAdd).toEqual([])
    expect(delta.toRemove).toEqual([])
  })

  it('classifies a last-advertised device absent from desired as toRemove (deviceId)', () => {
    const last = lastMap([[7, { fingerprint: 'aaa', externalIds: ['ep-7'] }]])
    const delta = diffExportTargets<Desired>([], last)
    expect(delta.toRemove).toEqual([7])
    expect(delta.toAdd).toEqual([])
    expect(delta.toUpdate).toEqual([])
  })

  it('handles a mixed add / update / unchanged / remove set', () => {
    const desired: Desired[] = [
      { deviceId: 1, fingerprint: 'new' }, // add
      { deviceId: 2, fingerprint: 'changed' }, // update
      { deviceId: 3, fingerprint: 'same' }, // unchanged
    ]
    const last = lastMap([
      [2, { fingerprint: 'old', externalIds: ['ep-2'] }],
      [3, { fingerprint: 'same', externalIds: ['ep-3'] }],
      [4, { fingerprint: 'gone', externalIds: ['ep-4'] }], // remove
    ])
    const delta = diffExportTargets(desired, last)
    expect(delta.toAdd).toEqual([{ deviceId: 1, fingerprint: 'new' }])
    expect(delta.toUpdate).toEqual([{ deviceId: 2, fingerprint: 'changed' }])
    expect(delta.toRemove).toEqual([4])
  })

  it('does not mutate its inputs', () => {
    const desired: Desired[] = [{ deviceId: 1, fingerprint: 'x' }]
    const last = lastMap([[2, { fingerprint: 'y', externalIds: [] }]])
    diffExportTargets(desired, last)
    expect(desired).toEqual([{ deviceId: 1, fingerprint: 'x' }])
    expect([...last.keys()]).toEqual([2])
  })
})

describe('resolveExportFingerprint', () => {
  it('returns the fresh fingerprint when the device is ready', () => {
    expect(resolveExportFingerprint({ ready: true, fresh: 'fresh', persisted: 'old' })).toBe(
      'fresh',
    )
  })

  it('carries forward the persisted fingerprint when NOT ready and a persisted entry exists', () => {
    expect(resolveExportFingerprint({ ready: false, fresh: 'fresh', persisted: 'old' })).toBe('old')
  })

  it('falls back to fresh when NOT ready and no persisted entry exists', () => {
    expect(resolveExportFingerprint({ ready: false, fresh: 'fresh', persisted: undefined })).toBe(
      'fresh',
    )
  })

  it('a carried-forward fingerprint nets to no change in diffExportTargets', () => {
    // A device mid-probe: fresh shape differs, but resolve carries the
    // persisted fingerprint forward so the diff produces neither update nor remove.
    const persisted = 'persisted-fp'
    const resolved = resolveExportFingerprint({ ready: false, fresh: 'partial-fp', persisted })
    const last = lastMap([[1, { fingerprint: persisted, externalIds: ['ep-1'] }]])
    const delta = diffExportTargets<Desired>([{ deviceId: 1, fingerprint: resolved }], last)
    expect(delta).toEqual({ toAdd: [], toUpdate: [], toRemove: [] })
  })
})
