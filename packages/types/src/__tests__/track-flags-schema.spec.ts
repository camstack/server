/**
 * `TrackFlagsPatchSchema` / `TrackFlagsSchema` — the wire contract of the
 * per-track operator flags, and specifically of `debugNote`.
 *
 * The note is free text typed by an operator on a phone. The bound lives HERE,
 * at the boundary, and not in the viewer's `TextInput`: three surfaces write
 * this patch and only one of them is the app, so a `maxLength` prop bounds one
 * caller and nothing else. An unbounded TEXT column fed by a paste is how a
 * track row stops fitting the slim projection every list read pays for.
 */
import { describe, expect, it } from 'vitest'

import {
  MAX_TRACK_DEBUG_NOTE_LEN,
  TrackFlagsPatchSchema,
  TrackFlagsSchema,
} from '../capabilities/pipeline-analytics.cap.js'

describe('TrackFlagsPatchSchema — debugNote', () => {
  it('accepts a note at the limit', () => {
    const note = 'x'.repeat(MAX_TRACK_DEBUG_NOTE_LEN)
    expect(TrackFlagsPatchSchema.safeParse({ debug: true, debugNote: note }).success).toBe(true)
  })

  it('refuses a note past the limit', () => {
    const note = 'x'.repeat(MAX_TRACK_DEBUG_NOTE_LEN + 1)
    expect(TrackFlagsPatchSchema.safeParse({ debug: true, debugNote: note }).success).toBe(false)
  })

  it('accepts an empty note — that is how a note is CLEARED, not a missing key', () => {
    const parsed = TrackFlagsPatchSchema.safeParse({ debug: false, debugNote: '' })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.debugNote : null).toBe('')
  })

  it('keeps the note OPTIONAL — a patch that only flips a flag omits it', () => {
    const parsed = TrackFlagsPatchSchema.safeParse({ favourited: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.debugNote : 'not-parsed').toBeUndefined()
  })
})

describe('TrackFlagsSchema — the resolved answer', () => {
  it('carries the note as a REQUIRED string, so absent resolves to empty', () => {
    const bad = TrackFlagsSchema.safeParse({
      trackId: 't-1',
      markForTrain: false,
      debug: true,
      favourited: false,
      retrainStatus: 'none',
    })
    expect(bad.success).toBe(false)

    const good = TrackFlagsSchema.safeParse({
      trackId: 't-1',
      markForTrain: false,
      debug: true,
      favourited: false,
      retrainStatus: 'none',
      debugNote: '',
    })
    expect(good.success).toBe(true)
  })
})
