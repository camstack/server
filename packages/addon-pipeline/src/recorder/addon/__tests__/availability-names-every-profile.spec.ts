/**
 * `getAvailability` answers for ONE profile, and it has to say so.
 *
 * ## The miss
 *
 * 2026-09-10. The operator asked for a timelapse export off the LOW stream.
 * `recording.getAvailability` for camera 101 returned twenty ranges, every one
 * of them `profile: 'high'`, so the conclusion drawn — out loud, and wrongly —
 * was that no camera on this deployment records `low` at all.
 *
 * The operator knew better: `/media-fast/recordingsLow/101/low/2026/09/10/`
 * holds hours 00–10, **14 GB for that one camera**, on a different storage
 * location. The export ran fine when asked for `low` explicitly — 320 KB and
 * 52 s against 92 MB and 230 s for the same window in `high`.
 *
 * Nothing was broken in the reader. `availabilityFor` picks ONE profile on
 * purpose (`availabilityProfileFor`), because the timeline is a single bar and
 * enumerating all three triples the directory reads for a bar that would look
 * identical. The defect is that the ANSWER never said so: its shape is
 * `{ profile, startMs, endMs }[]`, which reads as "these are the profiles",
 * and a caller asking "what can I export?" got a false negative.
 *
 * ## The rule
 *
 * A read that deliberately answers about PART of what exists names the whole.
 * `profilesWithFootage` costs the same shallow directory read the profile
 * choice already makes, and `profile` on the input lets a caller ask for the
 * one it wants rather than inferring that the rest are absent.
 */
import { describe, expect, it } from 'vitest'
import { profilesWithFootage } from '../calendar-scan.js'

/**
 * A fake filesystem: absolute directory → entries. Explicit rather than
 * derived, because the first version of this fake guessed the shape from path
 * segments and answered `[]` for the very read under test — a fake that lies
 * is worse than no test.
 */
function fs(dirs: Record<string, readonly string[]>) {
  return async (abs: string): Promise<readonly string[]> => dirs[abs] ?? []
}

describe('profilesWithFootage', () => {
  it('names every profile that holds footage, not just the preferred one', async () => {
    const got = await profilesWithFootage(
      ['/recordings'],
      101,
      fs({
        '/recordings/101': ['high', 'low'],
        '/recordings/101/high': ['2026'],
        '/recordings/101/low': ['2026'],
      }),
    )
    expect([...got]).toEqual(['high', 'low'])
  })

  it('unions ACROSS roots — the profiles live on different locations', async () => {
    // The real shape on this hub: high under /recordings, low under
    // /media-fast/recordingsLow. A per-root answer sees one of them.
    const got = await profilesWithFootage(
      ['/recordings', '/media-fast/recordingsLow'],
      101,
      fs({
        '/recordings/101': ['high'],
        '/recordings/101/high': ['2026'],
        '/media-fast/recordingsLow/101': ['low'],
        '/media-fast/recordingsLow/101/low': ['2026'],
      }),
    )
    expect([...got]).toEqual(['high', 'low'])
  })

  it('omits an EMPTY profile directory left behind by a config change', async () => {
    // Non-emptiness, not existence — the same rule availabilityProfile keeps.
    const got = await profilesWithFootage(
      ['/recordings'],
      101,
      fs({
        '/recordings/101': ['high', 'low'],
        '/recordings/101/high': ['2026'],
        '/recordings/101/low': [],
      }),
    )
    expect([...got]).toEqual(['high'])
  })

  it('ignores non-profile directories the camera dir also hosts', async () => {
    // `events/` and the retired `strips/` trees are not playable profiles.
    const got = await profilesWithFootage(
      ['/recordings'],
      101,
      fs({
        '/recordings/101': ['high', 'events', 'strips'],
        '/recordings/101/high': ['2026'],
        '/recordings/101/events': ['x'],
        '/recordings/101/strips': ['y'],
      }),
    )
    expect([...got]).toEqual(['high'])
  })

  it('is empty for a camera with nothing recorded', async () => {
    const got = await profilesWithFootage(['/recordings'], 999, fs({}))
    expect([...got]).toEqual([])
  })
})
