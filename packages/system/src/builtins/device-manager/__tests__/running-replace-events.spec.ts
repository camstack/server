/**
 * `onStarted` / `onFinished` under a REPLACED native `running` (D990): the flip
 * detector watches the PUBLIC (merged) slice, so the events follow the assigned
 * boolean and its `since`; the native running flipping underneath emits none,
 * and the native phase rides on the merged slice.
 */
import { describe, expect, it } from 'vitest'
import { EventCategory, runtimeStatePolicyFor } from '@camstack/types'
import { harness, type Harness } from './mirror-harness.js'

const NATIVE = {
  running: false,
  since: 1,
  source: 'native',
  phase: 'Idle',
  lastFetchedAt: 1,
}
const FIELDS = ['running', 'source', 'lastFetchedAt', 'since']
const OWNED = (running: boolean, since: number) => ({
  owner: 'blk-run',
  mode: 'replace' as const,
  fields: FIELDS,
  values: { running, source: 'assigned', lastFetchedAt: since, since },
})

/** The `{ since, phase }` a running flip carries; the harness types every event as a slice change. */
function flipPayload(data: unknown): { since: unknown; phase: unknown } {
  if (typeof data === 'object' && data !== null && 'since' in data && 'phase' in data) {
    return { since: data.since, phase: data.phase }
  }
  return { since: undefined, phase: undefined }
}

/** The running flips, in order, with the `since` / `phase` they carried. */
function flips(h: Harness) {
  const pairs = h.categories
    .filter((c) => c !== EventCategory.DeviceNativeShadowChanged)
    .map((category, i) => ({ category, data: h.events[i] }))
  return pairs
    .filter(
      (p) =>
        p.category === EventCategory.RunningStarted || p.category === EventCategory.RunningFinished,
    )
    .map((p) => ({ category: p.category, ...flipPayload(p.data) }))
}

describe('running events under a replaced native running', () => {
  it('fire from the assigned running with its since, and keep the native phase', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(9, { 'running-state': NATIVE })
    await h.mirror.claim(9, 'running-state', OWNED(true, 100), h.settings)
    expect(flips(h)).toEqual([
      { category: EventCategory.RunningStarted, since: 100, phase: 'Idle' },
    ])

    // The NATIVE running flips both ways: the assigned value is unchanged, so no event.
    h.mirror.applySingleCapUpdate(9, 'running-state', {
      ...NATIVE,
      running: true,
      lastFetchedAt: 2,
    })
    h.mirror.applySingleCapUpdate(9, 'running-state', {
      ...NATIVE,
      running: false,
      lastFetchedAt: 3,
    })
    expect(flips(h)).toHaveLength(1)
    expect(h.mirror.capSlice(9, 'running-state')).toMatchObject({
      running: true,
      source: 'assigned',
      phase: 'Idle',
    })

    // The assigned running ends: onFinished with the new since.
    await h.mirror.patchOwned(
      9,
      'running-state',
      'blk-run',
      { running: false, since: 400 },
      h.settings,
    )
    expect(flips(h).at(-1)).toEqual({
      category: EventCategory.RunningFinished,
      since: 400,
      phase: 'Idle',
    })
  })

  it('removing the customization restores the native slice', async () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.seedMirror(9, { 'running-state': NATIVE })
    await h.mirror.claim(9, 'running-state', OWNED(true, 100), h.settings)
    await h.mirror.release(9, 'running-state', 'blk-run', h.settings)
    expect(h.mirror.capSlice(9, 'running-state')).toEqual(NATIVE)
    expect(flips(h).at(-1)).toEqual({
      category: EventCategory.RunningFinished,
      since: 1,
      phase: 'Idle',
    })
  })
})
