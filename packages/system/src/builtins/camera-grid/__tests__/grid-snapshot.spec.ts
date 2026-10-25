/**
 * A grid's snapshot comes from the composition, and NEVER from a dial.
 *
 * The operator's decision, verbatim: *"Lo snapshot possiamo sempre farlo dallo
 * stream sempre, non c'e' bisogno di comporre gli snapshots"* [we can always take the snapshot from the stream, there is no need to compose the snapshots] — sample a frame
 * from the composite that is ALREADY running. Composing N source snapshots into
 * a picture was the alternative and it is a second compositor with its own
 * geometry; a grid that dialled its sources to produce a thumbnail is the
 * other, and it defeats the entire on-demand design D519 is built on.
 *
 * So there are exactly three states and this suite pins all three, including
 * the one that answers nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { GridSnapshotSource, gridSnapshotAnswerFor } from '../grid-snapshot.js'
import type { GridLastFrameStore } from '../grid-snapshot.js'
import type { GridStreamLogger } from '../grid-stream-session.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01])
const STORED = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02])

function makeLogger(): GridStreamLogger & { readonly warnings: string[] } {
  const warnings: string[] = []
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warnings.push(message)
    }),
    error: vi.fn(),
    warnings,
  }
}

function makeStore(initial: Buffer | null): GridLastFrameStore & { last: Buffer | null } {
  const state: { last: Buffer | null } = { last: initial }
  return {
    get last() {
      return state.last
    },
    get: async () => state.last,
    put: async (_deviceId: number, jpeg: Buffer) => {
      state.last = jpeg
    },
  }
}

describe('gridSnapshotAnswerFor', () => {
  it('samples the LIVE composition when one is running', () => {
    expect(gridSnapshotAnswerFor({ running: true, hasStoredFrame: true })).toEqual({ kind: 'live' })
    expect(gridSnapshotAnswerFor({ running: true, hasStoredFrame: false })).toEqual({
      kind: 'live',
    })
  })

  it('serves the STORED frame when nothing is composing', () => {
    // A grid with no consumer has no stream, so there is no fresh frame to
    // take. The last one is stale and honest; waking N cameras for a thumbnail
    // would be fresh and wrong.
    expect(gridSnapshotAnswerFor({ running: false, hasStoredFrame: true })).toEqual({
      kind: 'stored',
    })
  })

  it('answers NOTHING when nothing is composing and nothing was ever composed', () => {
    expect(gridSnapshotAnswerFor({ running: false, hasStoredFrame: false })).toEqual({
      kind: 'none',
      reason: 'never-composed',
    })
  })
})

describe('GridSnapshotSource', () => {
  it('samples the running composition and keeps the frame for next time', async () => {
    const store = makeStore(null)
    const sampleFrame = vi.fn(async () => JPEG)
    const source = new GridSnapshotSource({
      logger: makeLogger(),
      sessionsFor: () => [{ isRunning: () => true, profile: 'high' }],
      sampleFrame,
      store,
    })

    const image = await source.getSnapshot(4581)

    expect(image?.contentType).toBe('image/jpeg')
    expect(image?.base64).toBe(JPEG.toString('base64'))
    expect(sampleFrame).toHaveBeenCalledTimes(1)
    // Kept, so a restart does not leave the grid with the courtesy card while
    // nobody is watching it — the exact defect the durable last-frame store was
    // written for.
    expect(store.last?.equals(JPEG)).toBe(true)
  })

  it('takes the HIGHEST running composition — a live `low` beats a dead `high`', async () => {
    const sampled: string[] = []
    const source = new GridSnapshotSource({
      logger: makeLogger(),
      sessionsFor: () => [
        { isRunning: () => false, profile: 'high' },
        { isRunning: () => true, profile: 'mid' },
        { isRunning: () => true, profile: 'low' },
      ],
      sampleFrame: async (session) => {
        sampled.push(session.profile)
        return JPEG
      },
      store: makeStore(null),
    })

    await source.getSnapshot(4581)
    expect(sampled).toEqual(['mid'])
  })

  it('serves the stored frame when NOTHING is composing, and samples nothing', async () => {
    const sampleFrame = vi.fn(async () => JPEG)
    const source = new GridSnapshotSource({
      logger: makeLogger(),
      sessionsFor: () => [{ isRunning: () => false, profile: 'high' }],
      sampleFrame,
      store: makeStore(STORED),
    })

    const image = await source.getSnapshot(4581)

    expect(image?.base64).toBe(STORED.toString('base64'))
    // THE RULE. Not one dial, not one acquisition, not one frame of ffmpeg.
    expect(sampleFrame).not.toHaveBeenCalled()
  })

  it('answers null when nothing is composing and nothing was ever composed — and SAYS so', async () => {
    const logger = makeLogger()
    const source = new GridSnapshotSource({
      logger,
      sessionsFor: () => [{ isRunning: () => false, profile: 'high' }],
      sampleFrame: vi.fn(async () => JPEG),
      store: makeStore(null),
    })

    expect(await source.getSnapshot(4581)).toBeNull()
    // A branch that produces nothing logs it: silence here reads as a broken
    // camera, and the truth is "this grid has never been watched".
    expect(logger.warnings.join(' ')).toContain('no frame')
  })

  it('falls back to the stored frame when the LIVE sample fails, and says why', async () => {
    const logger = makeLogger()
    const source = new GridSnapshotSource({
      logger,
      sessionsFor: () => [{ isRunning: () => true, profile: 'high' }],
      sampleFrame: async () => null,
      store: makeStore(STORED),
    })

    const image = await source.getSnapshot(4581)
    expect(image?.base64).toBe(STORED.toString('base64'))
    expect(logger.warnings.join(' ')).toContain('could not sample')
  })

  it('answers null for a device that is not a grid at all', async () => {
    const source = new GridSnapshotSource({
      logger: makeLogger(),
      sessionsFor: () => [],
      sampleFrame: vi.fn(async () => JPEG),
      store: makeStore(STORED),
    })
    // No sessions means this addon does not own the device. Serving SOME
    // device's stored frame for it would be the worst possible answer.
    expect(await source.getSnapshot(999)).toBeNull()
  })
})
