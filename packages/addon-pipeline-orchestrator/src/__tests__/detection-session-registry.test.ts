import { CAMERA_TRIGGER } from '@camstack/types'
import { describe, it, expect, vi } from 'vitest'
import { DetectionSessionRegistry } from '../detection-session-registry.js'

describe('DetectionSessionRegistry', () => {
  it('registers and retrieves a session', () => {
    const r = new DetectionSessionRegistry()
    const s = r.register(10, 'hub', 1000, CAMERA_TRIGGER)
    expect(s).toEqual({
      deviceId: 10,
      nodeId: 'hub',
      startedAt: 1000,
      triggeredBy: CAMERA_TRIGGER,
      teardownTimer: null,
    })
    expect(r.get(10)).toBe(s)
    expect(r.has(10)).toBe(true)
    expect(r.has(11)).toBe(false)
  })

  it('a re-register keeps the trigger that opened the session (D672)', () => {
    const r = new DetectionSessionRegistry()
    r.register(10, 'hub', 1000, { kind: 'sensor', deviceId: 1 })
    r.register(10, 'hub', 2000, { kind: 'camera' })
    expect(r.get(10)?.triggeredBy).toEqual({ kind: 'sensor', deviceId: 1 })
  })

  it('deregister returns the session and clears its teardown timer', () => {
    const r = new DetectionSessionRegistry()
    r.register(10, 'hub', 1000, CAMERA_TRIGGER)
    const timer = setTimeout(() => {}, 10_000)
    const spy = vi.spyOn(global, 'clearTimeout')
    r.setTeardownTimer(10, timer)
    const removed = r.deregister(10)
    expect(removed?.deviceId).toBe(10)
    expect(spy).toHaveBeenCalledWith(timer)
    expect(r.has(10)).toBe(false)
    spy.mockRestore()
    clearTimeout(timer)
  })

  it('clearTeardownTimer cancels and nulls the timer without removing the session', () => {
    const r = new DetectionSessionRegistry()
    r.register(10, 'hub', 1000, CAMERA_TRIGGER)
    const timer = setTimeout(() => {}, 10_000)
    r.setTeardownTimer(10, timer)
    r.clearTeardownTimer(10)
    expect(r.get(10)?.teardownTimer).toBeNull()
    expect(r.has(10)).toBe(true)
    clearTimeout(timer)
  })

  it('list returns all active sessions', () => {
    const r = new DetectionSessionRegistry()
    r.register(10, 'hub', 1000, CAMERA_TRIGGER)
    r.register(20, 'agent', 2000, CAMERA_TRIGGER)
    expect(
      r
        .list()
        .map((s) => s.deviceId)
        .sort(),
    ).toEqual([10, 20])
  })

  it('clear cancels every timer and empties the map', () => {
    const r = new DetectionSessionRegistry()
    r.register(10, 'hub', 1000, CAMERA_TRIGGER)
    const timer = setTimeout(() => {}, 10_000)
    const spy = vi.spyOn(global, 'clearTimeout')
    r.setTeardownTimer(10, timer)
    r.clear()
    expect(spy).toHaveBeenCalledWith(timer)
    expect(r.list()).toEqual([])
    spy.mockRestore()
    clearTimeout(timer)
  })

  it('setTeardownTimer on an unknown device is a no-op (no throw)', () => {
    const r = new DetectionSessionRegistry()
    expect(() =>
      r.setTeardownTimer(
        99,
        setTimeout(() => {}, 1),
      ),
    ).not.toThrow()
  })

  describe('edges (D907)', () => {
    it('reports one open per session and one close per deregister; a re-register is not an edge', () => {
      const edges: string[] = []
      const r = new DetectionSessionRegistry(undefined, (e) =>
        edges.push(`${e.edge}:${e.deviceId}`),
      )
      r.register(10, 'hub', 1000, CAMERA_TRIGGER)
      r.register(10, 'hub', 2000, CAMERA_TRIGGER)
      r.deregister(10)
      r.deregister(10)
      expect(edges).toEqual(['open:10', 'close:10'])
    })

    it('clear() closes every live session', () => {
      const edges: string[] = []
      const r = new DetectionSessionRegistry(undefined, (e) =>
        edges.push(`${e.edge}:${e.deviceId}`),
      )
      r.register(10, 'hub', 1000, CAMERA_TRIGGER)
      r.register(11, 'hub', 1000, CAMERA_TRIGGER)
      r.clear()
      expect(edges).toEqual(['open:10', 'open:11', 'close:10', 'close:11'])
    })
  })
})
