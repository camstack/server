import { describe, expect, it } from 'vitest'
import { NodeLivenessMirror, parseTopologySnapshotNodes } from '../node-liveness.js'

/**
 * The gate that stops key-frame captures being dispatched at a node the
 * registry already called dead (2026-08-06: 403 of the day's key-frame misses
 * were `pipeline-runner not routable to node <X>: node-offline`).
 *
 * Every assertion here is about the DIRECTION the mirror is allowed to be
 * wrong in. Gating means storing no media for a camera, so each test below
 * pins one way the mirror must fall OPEN.
 */
describe('NodeLivenessMirror', () => {
  it('never gates before the first snapshot arrives', () => {
    const mirror = new NodeLivenessMirror()
    expect(mirror.isKnownOffline('laptop', 1_000)).toBe(false)
  })

  it('never gates a node no snapshot ever mentioned', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'hub', isOnline: true }], 1_000)
    expect(mirror.isKnownOffline('laptop', 1_000)).toBe(false)
  })

  it('does NOT gate on the first offline report — one read is not enough (D49)', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    expect(mirror.isKnownOffline('laptop', 1_000)).toBe(false)
  })

  it('gates once a SECOND consecutive snapshot agrees', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 31_000)
    expect(mirror.isKnownOffline('laptop', 31_000)).toBe(true)
  })

  it('re-opens the gate the moment the node reports online again', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 31_000)
    expect(mirror.isKnownOffline('laptop', 31_000)).toBe(true)
    mirror.applySnapshot([{ id: 'laptop', isOnline: true }], 61_000)
    expect(mirror.isKnownOffline('laptop', 61_000)).toBe(false)
  })

  it('treats DISAPPEARANCE from a snapshot as unknown, not as death', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 31_000)
    expect(mirror.isKnownOffline('laptop', 31_000)).toBe(true)
    // The node is unregistered: the registry stops describing it entirely.
    mirror.applySnapshot([{ id: 'hub', isOnline: true }], 61_000)
    expect(mirror.isKnownOffline('laptop', 61_000)).toBe(false)
    // …and the streak restarted from zero, so one report cannot re-gate it.
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 91_000)
    expect(mirror.isKnownOffline('laptop', 91_000)).toBe(false)
  })

  it('expires: a mirror nobody refreshed stops gating anything', () => {
    const mirror = new NodeLivenessMirror({ staleAfterMs: 120_000 })
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 2_000)
    expect(mirror.isKnownOffline('laptop', 2_000)).toBe(true)
    expect(mirror.isKnownOffline('laptop', 122_000)).toBe(true)
    expect(mirror.isKnownOffline('laptop', 122_001)).toBe(false)
  })

  it('clear() forgets everything', () => {
    const mirror = new NodeLivenessMirror()
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 1_000)
    mirror.applySnapshot([{ id: 'laptop', isOnline: false }], 2_000)
    mirror.clear()
    expect(mirror.isKnownOffline('laptop', 2_000)).toBe(false)
  })
})

describe('parseTopologySnapshotNodes', () => {
  it('reads the emitter payload shape', () => {
    expect(
      parseTopologySnapshotNodes({
        nodes: [
          { id: 'hub', isOnline: true, name: 'Hub' },
          { id: 'laptop', isOnline: false, name: 'Laptop' },
        ],
        timestamp: 1,
      }),
    ).toEqual([
      { id: 'hub', isOnline: true },
      { id: 'laptop', isOnline: false },
    ])
  })

  it('returns null for a payload that is not a node snapshot', () => {
    expect(parseTopologySnapshotNodes(null)).toBeNull()
    expect(parseTopologySnapshotNodes(undefined)).toBeNull()
    expect(parseTopologySnapshotNodes({})).toBeNull()
    expect(parseTopologySnapshotNodes({ nodes: 'all of them' })).toBeNull()
  })

  it('drops entries missing the two fields rather than inventing them', () => {
    expect(
      parseTopologySnapshotNodes({ nodes: [{ id: 'hub' }, { isOnline: false }, null, 7] }),
    ).toEqual([])
  })
})
