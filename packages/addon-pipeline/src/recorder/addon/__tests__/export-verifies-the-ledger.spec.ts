/**
 * The seam: an EXPORT verifies the hour ledger against the array, a PLAYBACK
 * read never does (D445).
 *
 * `collectRangeSegments` already carries this asymmetry once — `uriMode ===
 * 'absolute'` (export) stats every file because ffmpeg dies on the first
 * missing one, while playback trusts the index because the stat storm cost a
 * multi-second stall on every scrub cursor. The ledger verification rides the
 * SAME distinction, for the same reason: an export walks its window once and a
 * short answer is a whole night missing from a file; a scrub walks it per drag
 * and a `readdir` per hour there is exactly the FUSE stall the ledger exists
 * to remove.
 *
 * Both cases matter. Without the first, camera 4374's timelapse renders from a
 * fifth of its night. Without the second, the fix for that becomes the 2026-08-22
 * `segment read timeout` all over again.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { RecordingConfigsState } from '../config-store.js'
import { collectRangeSegments, type RecordingProviderDeps } from '../recording-provider.js'

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

/** Every `hydrateWindow` call the read made, with the flag it carried. */
interface HydrateCall {
  readonly deviceId: number
  readonly verify: boolean | undefined
}

function harness(): { deps: RecordingProviderDeps; calls: HydrateCall[] } {
  const index = new RecordingIndex()
  index.addSegment({
    deviceId: 4374,
    profile: 'low',
    startMs: 1_000_000,
    durMs: 10_000,
    bytes: 50_000,
    path: '4374/low/2026/09/10/20/1000000-10000-50000.m4s',
    locationId: 'loc-a',
  })
  // The window is already `hydrated` — the state in which the defect lives:
  // the hour was seeded from a ledger row that was short, and every reader
  // since has been told the archive holds only that.
  index.markHydrated(4374, 0, 2_000_000)

  const calls: HydrateCall[] = []
  const deps = {
    index,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [{ id: 'loc-a', root: '/recordings/a' }],
    statFile: async () => ({}),
    hydrateWindow: async (deviceId: number, _from: number, _to: number, verify?: boolean) => {
      calls.push({ deviceId, verify })
    },
  } as unknown as RecordingProviderDeps
  return { deps, calls }
}

describe('an export asks the array whether the ledger was complete', () => {
  it('verifies even when the window already reads as hydrated', async () => {
    const h = harness()
    await collectRangeSegments(h.deps, 4374, 'low', 0, 2_000_000, 'absolute')

    // `hydrated` must not short-circuit it: an hour hydrated FROM a short
    // ledger row is precisely the case the verification exists to catch, and
    // gating on that flag is what made the defect unreachable.
    expect(h.calls).toEqual([{ deviceId: 4374, verify: true }])
  })

  it('leaves the playback path exactly as it was — no call, no readdir', async () => {
    const h = harness()
    await collectRangeSegments(h.deps, 4374, 'low', 0, 2_000_000, 'playback-relative')

    expect(h.calls).toEqual([])
  })
})
