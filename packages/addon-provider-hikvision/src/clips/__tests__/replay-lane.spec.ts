/**
 * The camera's one playback slot, held by the provider rather than discovered
 * from a 500.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { createReplayLane, REPLAY_LANE_WAIT_MS } from '../replay-lane.js'

function scopedLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('the replay lane', () => {
  it('lets one replay hold a camera and hands the slot on when it is released', async () => {
    const lane = createReplayLane({ logger: scopedLogger(), waitMs: 50 })
    const first = await lane.acquire(1436, 'stream')
    expect(first.kind).toBe('held')
    expect(lane.held(1436)).toBe(true)
    // A DIFFERENT camera is a different slot and never waits behind this one.
    const other = await lane.acquire(3833, 'file')
    expect(other.kind).toBe('held')
    const second = lane.acquire(1436, 'file')
    if (first.kind !== 'held') return
    first.release()
    expect(await second).toMatchObject({ kind: 'held' })
    expect(lane.held(1436)).toBe(true)
  })

  it('refuses BY NAME rather than dialling a camera whose slot is held', async () => {
    // The whole point: the second ask never reaches the camera, so it can
    // never come back as the opaque `SETUP … 500` that a surface reads as
    // "this clip is broken" (D611/D315).
    const logger = scopedLogger()
    const lane = createReplayLane({ logger, waitMs: 20 })
    const held = await lane.acquire(1436, 'stream')
    expect(held.kind).toBe('held')
    const refused = await lane.acquire(1436, 'file')
    expect(refused.kind).toBe('busy')
    if (refused.kind !== 'busy') return
    expect(refused.holder).toBe('stream')
    expect(refused.detail).toContain('replay-busy')
    expect(refused.waitedMs).toBeGreaterThanOrEqual(0)
    // A refusal WE issue is still a refusal, and silence reads as "never
    // happened" (D391).
    expect(logger.warn).toHaveBeenCalledWith(
      'videoclips: a replay was refused — the camera’s slot is held',
      expect.objectContaining({ tags: { deviceId: 1436 } }),
    )
  })

  it('waits for a slot that is being handed back, and not for one that is playing', async () => {
    // The commonest overlap is one operator moving from clip A to clip B: A's
    // TEARDOWN is on the wire while B's SETUP is being written. Refusing B for
    // want of a few hundred milliseconds would make every second tap an error.
    const lane = createReplayLane({ logger: scopedLogger(), waitMs: 200 })
    const first = await lane.acquire(1436, 'stream')
    if (first.kind !== 'held') return
    setTimeout(() => first.release(), 20)
    expect(await lane.acquire(1436, 'stream')).toMatchObject({ kind: 'held' })
    // And the bound is the teardown flush plus a margin, never long enough to
    // queue behind a replay that is still playing — a Hikvision replay arrives
    // at 1×, so that would mean the whole length of somebody else's clip.
    expect(REPLAY_LANE_WAIT_MS).toBeLessThan(5_000)
  })

  it('releases idempotently, and a stale release never frees somebody else’s slot', async () => {
    const lane = createReplayLane({ logger: scopedLogger(), waitMs: 10 })
    const first = await lane.acquire(1436, 'file')
    if (first.kind !== 'held') return
    first.release()
    const second = await lane.acquire(1436, 'stream')
    expect(second.kind).toBe('held')
    // The first holder releasing a second time must not evict the second.
    first.release()
    expect(lane.held(1436)).toBe(true)
  })
})
