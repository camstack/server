/**
 * The note SURVIVES the review (D405).
 *
 * D353 made `debug: false` clear `debugNote` in the same statement, and that
 * invariant stays: a track must never present a question without the flag that
 * explains it. What is added here is the half D405 supersedes — the clear is no
 * longer a DELETE. Before the column goes, `applyTrackFlags` appends the note to
 * an archive that is not a track row and is not subject to track retention.
 *
 * The failure being fixed is not hypothetical: on 2026-09-08 the 25–27 notes
 * written during one morning's sweep were unreadable by that afternoon, because
 * reviewing them is what destroyed them. Only the 11 still-open marks remained.
 *
 * Three properties are pinned here, and the third is the one that matters at
 * 03:00:
 *
 *  1. the note reaches the archive BEFORE the row is cleared, with the camera
 *     and the track's context attached;
 *  2. the clear still happens — `debugNote: ''` is still in the patch, always;
 *  3. an archive that FAILS costs the operator neither the flag write they
 *     asked for nor the words: the flag lands anyway, and the note text is put
 *     in the log line, tagged with the camera, so it is recoverable by hand.
 */

import type { RetrainStatus } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeLogRecorder, makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { DebugNoteArchiveAppendInput, DebugNoteArchivePort } from '../archive-debug-note.js'
import { type ApplyTrackFlagsDeps, applyTrackFlags, type TrackFlagsStore } from '../track-flags.js'

type FakeFlagsStore = TrackFlagsStore & {
  readonly writes: { trackId: string; patch: Record<string, unknown> }[]
}

interface CurrentFlags {
  readonly retrainStatus: RetrainStatus
  readonly debug: boolean
  readonly debugNote?: string
  readonly startedAt?: number
  readonly className?: string
  readonly label?: string
}

function makeStore(current: CurrentFlags): FakeFlagsStore {
  const writes: { trackId: string; patch: Record<string, unknown> }[] = []
  return {
    writes,
    readFlags: vi.fn(async () => ({
      retrainStatus: current.retrainStatus,
      debug: current.debug,
      favourited: false,
      debugNote: current.debugNote ?? '',
      ...(current.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
      ...(current.className !== undefined ? { className: current.className } : {}),
      ...(current.label !== undefined ? { label: current.label } : {}),
    })),
    setFlags: vi.fn(async (trackId, patch) => {
      writes.push({ trackId, patch: { ...patch } })
    }),
    countStaging: vi.fn(async () => 0),
  }
}

interface RecordingArchive extends DebugNoteArchivePort {
  readonly appended: DebugNoteArchiveAppendInput[]
}

function makeArchive(): RecordingArchive {
  const appended: DebugNoteArchiveAppendInput[] = []
  return {
    appended,
    append: async (input) => {
      appended.push(input)
      return { archived: true, id: `id-${appended.length}` }
    },
  }
}

function deps(store: TrackFlagsStore, archive?: DebugNoteArchivePort): ApplyTrackFlagsDeps {
  return {
    store,
    logger: makeSilentLogger(),
    ...(archive !== undefined ? { noteArchive: archive } : {}),
  }
}

describe('applyTrackFlags — archiving the note the review clears', () => {
  it('archives the standing note, with the camera and the track context, when debug goes off', async () => {
    const store = makeStore({
      retrainStatus: 'none',
      debug: true,
      debugNote: 'the box jumps to the fence at 22:14',
      startedAt: 1_699_999_000_000,
      className: 'person',
      label: 'Alice',
    })
    const archive = makeArchive()

    await applyTrackFlags(deps(store, archive), {
      deviceId: 102,
      trackId: 'trk-1',
      flags: { debug: false },
    })

    expect(archive.appended).toEqual([
      {
        deviceId: 102,
        sourceTrackId: 'trk-1',
        note: 'the box jumps to the fence at 22:14',
        trackStartedAt: 1_699_999_000_000,
        trackClass: 'person',
        trackLabel: 'Alice',
      },
    ])
  })

  it('still CLEARS the note off the track row — D353 survives the archiving', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'was checking this' })
    const archive = makeArchive()

    const out = await applyTrackFlags(deps(store, archive), {
      deviceId: 101,
      trackId: 'trk-2',
      flags: { debug: false },
    })

    expect(store.writes).toEqual([{ trackId: 'trk-2', patch: { debug: false, debugNote: '' } }])
    expect(out.debugNote).toBe('')
  })

  it('archives BEFORE the row is written — a crash between the two must not lose the note', async () => {
    const order: string[] = []
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'ordering matters' })
    const archive: DebugNoteArchivePort = {
      append: async (input) => {
        order.push('archive')
        return { archived: true, id: input.sourceTrackId }
      },
    }
    const spied: TrackFlagsStore = {
      ...store,
      setFlags: async (trackId, patch) => {
        order.push('setFlags')
        await store.setFlags(trackId, patch)
      },
    }

    await applyTrackFlags(deps(spied, archive), {
      deviceId: 101,
      trackId: 'trk-3',
      flags: { debug: false },
    })

    expect(order).toEqual(['archive', 'setFlags'])
  })

  it('archives nothing when the track carried no note', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: '' })
    const archive = makeArchive()

    await applyTrackFlags(deps(store, archive), {
      deviceId: 101,
      trackId: 'trk-4',
      flags: { debug: false },
    })

    expect(archive.appended).toEqual([])
  })

  it('archives nothing when the patch does not turn debug off', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'still open' })
    const archive = makeArchive()

    await applyTrackFlags(deps(store, archive), {
      deviceId: 101,
      trackId: 'trk-5',
      flags: { favourited: true },
    })

    expect(archive.appended).toEqual([])
  })

  it('a FAILED archive still writes the flag the operator asked for, and logs the note verbatim', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'the words at risk' })
    const recorder = makeLogRecorder()
    const archive: DebugNoteArchivePort = {
      append: async () => {
        throw new Error('sqlite is busy')
      },
    }

    const out = await applyTrackFlags(
      { store, logger: recorder.logger, noteArchive: archive },
      { deviceId: 102, trackId: 'trk-6', flags: { debug: false } },
    )

    // The flag write is what the operator pressed; it lands regardless.
    expect(store.writes).toEqual([{ trackId: 'trk-6', patch: { debug: false, debugNote: '' } }])
    expect(out.debug).toBe(false)

    // And the note is NOT silently lost: it is in the log, per-camera, verbatim.
    const line = recorder.entries.find((e) => e.message.includes('debug note'))
    expect(line?.level).toBe('error')
    expect(line?.extras?.tags).toEqual({ deviceId: 102 })
    expect(JSON.stringify(line?.extras?.meta)).toContain('the words at risk')
  })

  it('clears the note with no archive wired at all — the flag write never depends on it', async () => {
    const store = makeStore({ retrainStatus: 'none', debug: true, debugNote: 'no archive here' })

    const out = await applyTrackFlags(deps(store), {
      deviceId: 101,
      trackId: 'trk-7',
      flags: { debug: false },
    })

    expect(store.writes).toEqual([{ trackId: 'trk-7', patch: { debug: false, debugNote: '' } }])
    expect(out.debugNote).toBe('')
  })
})
