/**
 * The production wiring for the subject-tile cut — the seam that shipped broken.
 *
 * ## What went wrong, and why the first tests did not see it
 *
 * `cutSubjectTiles` looked its cutter up in `NativeCropRegistry`: a NODE-WIDE
 * LRU, capped at 256 entries, shared by every camera, whose reason to exist is
 * serving LATE cross-process crops. On the live hub during the incident that
 * registry sat **pinned at `registrySize=256 registryCap=256`** — so an entry's
 * lifetime is a function of how busy the OTHER cameras are, and a lookup for
 * one camera's frame can fail because a different camera is busy.
 *
 * Every existing test drove the COORDINATOR (`image.cutTiles(...)`) directly,
 * so all of them passed while the runner between them never called it. The
 * production result was `tilesCut: 0` on every camera, `holdOverflow: 180+`
 * (the hold never released, so the frame bound churned), a collapsed retention
 * window, and a capture-retry storm on top of it.
 *
 * These tests therefore exercise the addon's OWN binding — bound at delivery,
 * consumed at the result — and specifically pin the property the registry could
 * not give: **eviction pressure from other cameras must not stop a frame's
 * result from ending its hold.**
 */

import type { FrameHandle } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { NativeCropRegistry } from '../../session-decode/native-crop-registry.js'
import { FrameCutterBinding } from '../frame-cutter-binding.js'
import type { NativeCropRequester } from '../../session-decode/session-decode-pump.js'

const handleAt = (seq: number, device = 101): FrameHandle => ({
  shmId: `ram:node:${device}`,
  slot: 1,
  seq,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: seq,
  byteLength: 100,
  nodeId: 'node',
  slotCount: 8,
})

function makeCutter(): NativeCropRequester {
  const fn = vi.fn(async () => null)
  return Object.assign(fn, {
    cutTiles: vi.fn(),
    release: vi.fn(),
    markInferred: vi.fn(),
  }) as unknown as NativeCropRequester
}

describe('the registry is the WRONG place to look a cutter up', () => {
  // This is the production condition, reproduced: one busy fleet saturating the
  // shared LRU while ONE camera waits for its own frame's result.
  it('a saturated node-wide registry loses a frame’s entry before its result arrives', () => {
    const registry = new NativeCropRegistry(256)
    const mine = handleAt(1, 101)
    registry.register(mine, makeCutter(), 101)

    // 256 frames from OTHER cameras arrive while inference runs on mine.
    for (let i = 0; i < 256; i += 1) registry.register(handleAt(1000 + i, 102), makeCutter(), 102)

    // My frame's result comes back — and its cutter is gone, evicted by traffic
    // that has nothing to do with this camera.
    expect(registry.lookup(mine).kind).toBe('unknown')
  })

  it('the per-frame binding survives exactly that pressure', () => {
    const binding = new FrameCutterBinding(256)
    const mine = handleAt(1, 101)
    const cutter = makeCutter()
    binding.bind(mine, cutter)

    for (let i = 0; i < 200; i += 1) binding.bind(handleAt(1000 + i, 102), makeCutter())

    const found = binding.take(mine)
    expect(found).toBe(cutter)
    found?.cutTiles([])
    expect(cutter.cutTiles).toHaveBeenCalledWith([])
  })
})

describe('frame cutter binding', () => {
  it('is consumed exactly once — a second result cannot double-release', () => {
    const binding = new FrameCutterBinding(8)
    const h = handleAt(1)
    const cutter = makeCutter()
    binding.bind(h, cutter)
    expect(binding.take(h)).toBe(cutter)
    expect(binding.take(h)).toBeUndefined()
    expect(binding.size).toBe(0)
  })

  // A result that never arrives (a shed, an inference timeout, a detach
  // mid-flight) must not leave the frame held forever.
  it('releases the hold of a frame whose result never came back', () => {
    const binding = new FrameCutterBinding(2)
    const abandoned = makeCutter()
    binding.bind(handleAt(1), abandoned)
    binding.bind(handleAt(2), makeCutter())
    binding.bind(handleAt(3), makeCutter())
    expect(abandoned.release).toHaveBeenCalledTimes(1)
    expect(binding.size).toBe(2)
  })

  it('does not leak a binding per frame under steady traffic', () => {
    const binding = new FrameCutterBinding(256)
    for (let i = 0; i < 5000; i += 1) {
      const h = handleAt(i)
      binding.bind(h, makeCutter())
      binding.take(h) // the result always comes back
    }
    expect(binding.size).toBe(0)
  })

  // A frame the runner let go without a result — superseded in the
  // latest-wins queue, an inference error, a timeout — must end its hold NOW,
  // not 256 bindings later. Measured 2026-09-06: at 40% queue drops the
  // worker's hold overflowed on three of every four admits.
  it('a DROPPED frame ends its hold at once, and only once', () => {
    const binding = new FrameCutterBinding(256)
    const h = handleAt(1)
    const cutter = makeCutter()
    binding.bind(h, cutter)
    binding.drop(h)
    expect(cutter.release).toHaveBeenCalledTimes(1)
    expect(binding.size).toBe(0)
    binding.drop(h)
    expect(binding.take(h)).toBeUndefined()
    expect(cutter.release).toHaveBeenCalledTimes(1)
  })

  it('re-binding the same handle does not strand the first cutter', () => {
    const binding = new FrameCutterBinding(8)
    const h = handleAt(1)
    const first = makeCutter()
    binding.bind(h, first)
    binding.bind(h, makeCutter())
    expect(binding.size).toBe(1)
  })
})
