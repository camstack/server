import { describe, it, expect } from 'vitest'
import { OverlayDetailStateStore } from '../overlay-state.js'

describe('OverlayDetailStateStore', () => {
  it('stores a face detail in FRAME SPACE (absolute pixels)', () => {
    const store = new OverlayDetailStateStore()
    store.noteFaceDetail(9, 't1', { x: 150, y: 220, w: 50, h: 60 }, 0.8, 1000)
    const state = store.get(9, 't1')
    expect(state?.face).toEqual({
      bbox: { x: 150, y: 220, w: 50, h: 60 },
      score: 0.8,
      capturedAt: 1000,
    })
  })

  it('keeps face and plate independently on the same track', () => {
    const store = new OverlayDetailStateStore()
    store.noteFaceDetail(9, 't1', { x: 100, y: 200, w: 100, h: 100 }, 0.5, 1)
    store.notePlateDetail(9, 't1', { x: 200, y: 400, w: 100, h: 50 }, 0.9, 'AB123CD', 2)
    const state = store.get(9, 't1')
    expect(state?.face?.bbox).toEqual({ x: 100, y: 200, w: 100, h: 100 })
    expect(state?.plate).toEqual({
      bbox: { x: 200, y: 400, w: 100, h: 50 },
      score: 0.9,
      capturedAt: 2,
      text: 'AB123CD',
    })
  })

  it('a fresher face detail replaces the previous one', () => {
    const store = new OverlayDetailStateStore()
    store.noteFaceDetail(9, 't1', { x: 100, y: 200, w: 100, h: 100 }, 0.5, 1)
    store.noteFaceDetail(9, 't1', { x: 150, y: 250, w: 50, h: 50 }, 0.7, 2)
    const face = store.get(9, 't1')?.face
    expect(face?.capturedAt).toBe(2)
    expect(face?.bbox).toEqual({ x: 150, y: 250, w: 50, h: 50 })
  })

  it('onTrackEnded drops only that track; clearDevice drops the device', () => {
    const store = new OverlayDetailStateStore()
    store.noteFaceDetail(9, 't1', { x: 100, y: 200, w: 10, h: 10 }, 0.5, 1)
    store.noteFaceDetail(9, 't2', { x: 100, y: 200, w: 10, h: 10 }, 0.5, 1)
    store.noteFaceDetail(7, 'tx', { x: 100, y: 200, w: 10, h: 10 }, 0.5, 1)
    store.onTrackEnded(9, 't1')
    expect(store.get(9, 't1')).toBeUndefined()
    expect(store.get(9, 't2')).toBeDefined()
    store.clearDevice(9)
    expect(store.get(9, 't2')).toBeUndefined()
    expect(store.get(7, 'tx')).toBeDefined()
    store.clear()
    expect(store.get(7, 'tx')).toBeUndefined()
  })
})
