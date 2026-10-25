/**
 * The lifecycle moves the retrain page owns — the FIRST writer of `'trained'`.
 *
 * D81 shipped the column with the third state deliberately unreachable. What is
 * pinned here is that it stays hard to reach in the ways that matter:
 *
 *  - `complete` refuses a track the dataset holds NO copies from. `trained`
 *    un-pins the track's media; completing with no copy is a delete order for
 *    material nothing extracted anything from, and it is the entire safety
 *    argument of D81.
 *  - `complete` refuses anything that is not `staging`, so a never-marked track
 *    cannot be walked into the dataset's accounting.
 *  - `restage` refuses anything that is not `trained` — the plain toggle owns
 *    `none ↔ staging`, and two writers of one transition is how the same
 *    material gets annotated twice.
 *  - `restage` leaves the copies and annotations ALONE. "Put this back" must
 *    not be destructive.
 */

import type { RetrainStatus } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  completeRetrainTrack,
  type RetrainLifecycleDeps,
  restageRetrainTrack,
} from '../retrain-lifecycle.js'

interface Arrange {
  readonly status: RetrainStatus | null
  readonly frames?: number
  readonly annotations?: number
}

function makeDeps(arrange: Arrange): {
  deps: RetrainLifecycleDeps
  written: { trackId: string; status: RetrainStatus }[]
} {
  const written: { trackId: string; status: RetrainStatus }[] = []
  const deps: RetrainLifecycleDeps = {
    store: {
      readStatus: async () => arrange.status,
      setStatus: async (trackId, status) => {
        written.push({ trackId, status })
      },
    },
    logger: makeSilentLogger(),
    countFrames: async () => arrange.frames ?? 0,
    countAnnotations: async () => arrange.annotations ?? 0,
  }
  return { deps, written }
}

const INPUT = { deviceId: 101, trackId: 'track-a' } as const

describe('completeRetrainTrack', () => {
  it('moves staging → trained when the dataset holds copies', async () => {
    const { deps, written } = makeDeps({ status: 'staging', frames: 2, annotations: 5 })

    const result = await completeRetrainTrack(deps, INPUT)

    expect(result).toEqual({ kind: 'moved', from: 'staging', to: 'trained' })
    expect(written).toEqual([{ trackId: 'track-a', status: 'trained' }])
  })

  it('REFUSES a track no frame was ever copied from, and writes nothing', async () => {
    const { deps, written } = makeDeps({ status: 'staging', frames: 0 })

    const result = await completeRetrainTrack(deps, INPUT)

    expect(result).toMatchObject({ kind: 'refused', reason: 'no-frames-copied' })
    expect(written).toEqual([])
  })

  it('refuses a track that was never marked', async () => {
    const { deps, written } = makeDeps({ status: 'none', frames: 3 })

    const result = await completeRetrainTrack(deps, INPUT)

    expect(result).toMatchObject({ kind: 'refused', reason: 'not-staging' })
    expect(written).toEqual([])
  })

  it('refuses an unknown track', async () => {
    const { deps } = makeDeps({ status: null })
    expect(await completeRetrainTrack(deps, INPUT)).toMatchObject({
      kind: 'refused',
      reason: 'unknown-track',
    })
  })

  it('is idempotent on an already-trained track', async () => {
    const { deps, written } = makeDeps({ status: 'trained', frames: 1 })

    expect(await completeRetrainTrack(deps, INPUT)).toEqual({
      kind: 'unchanged',
      status: 'trained',
    })
    expect(written).toEqual([])
  })

  it('allows — and LOUDLY logs — a completion with zero annotations', async () => {
    const { deps, written } = makeDeps({ status: 'staging', frames: 1, annotations: 0 })
    const warn = vi.spyOn(deps.logger, 'warn')

    const result = await completeRetrainTrack(deps, INPUT)

    expect(result).toMatchObject({ kind: 'moved', to: 'trained' })
    expect(written).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('ZERO annotations')
    expect(warn.mock.calls[0]![1]).toMatchObject({ tags: { deviceId: 101 } })
  })
})

describe('restageRetrainTrack', () => {
  it('moves trained → staging', async () => {
    const { deps, written } = makeDeps({ status: 'trained', frames: 2, annotations: 4 })

    expect(await restageRetrainTrack(deps, INPUT)).toEqual({
      kind: 'moved',
      from: 'trained',
      to: 'staging',
    })
    expect(written).toEqual([{ trackId: 'track-a', status: 'staging' }])
  })

  it('refuses a never-trained track — that transition belongs to the toggle', async () => {
    const { deps, written } = makeDeps({ status: 'none' })

    expect(await restageRetrainTrack(deps, INPUT)).toMatchObject({
      kind: 'refused',
      reason: 'not-trained',
    })
    expect(written).toEqual([])
  })

  it('is idempotent on a track already in staging', async () => {
    const { deps, written } = makeDeps({ status: 'staging' })

    expect(await restageRetrainTrack(deps, INPUT)).toEqual({
      kind: 'unchanged',
      status: 'staging',
    })
    expect(written).toEqual([])
  })
})
