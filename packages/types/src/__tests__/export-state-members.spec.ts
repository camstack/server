/**
 * `ExportStateSchema` has SIX members, and this test is the only thing standing
 * between a seventh and every installed viewer rendering live exports as
 * FAILED.
 *
 * The viewer mirrors the record shape by hand rather than importing
 * `z.infer<typeof ExportRecordSchema>`:
 *
 * ```ts
 * // camstack/src/data/use-exports.ts
 * function toState(v: unknown): ExportState {
 *   return typeof v === 'string' && EXPORT_STATES.has(v) ? (v as ExportState) : 'failed'
 * }
 * ```
 *
 * `EXPORT_STATES` there is a LOCAL copy of the six names. An unknown state
 * string is not "unknown" to that function — it is `failed`. So adding a
 * seventh member here (`'fetching'` was the obvious one while clip export was
 * designed) does not degrade gracefully: it renders every queued and rendering
 * export, of BOTH kinds, as a failure on every app already on a phone, until
 * the app is updated — and the same modal now serves recordings and clips
 * alike, so the blast radius is the whole Library (D558 § 6.1).
 *
 * Adding a FIELD is safe (the hand-written mapper ignores what it does not
 * read) — which is exactly why `ExportRecord.subject` is a field and a clip
 * export reuses `rendering` with `subject.kind` saying what it means.
 *
 * If you are here because a new state is genuinely needed: ship the viewer
 * first, wait out the installed base, and only then change this list.
 */
import { describe, expect, it } from 'vitest'
import { ExportStateSchema } from '../capabilities/recording-export.cap.js'

describe('ExportStateSchema — pinned members', () => {
  it('has exactly the six states the viewer mirrors by hand', () => {
    expect([...ExportStateSchema.options]).toEqual([
      'queued',
      'rendering',
      'ready',
      'failed',
      'expired',
      'deleted',
    ])
  })

  it('refuses a seventh member such as the clip export fetch phase', () => {
    expect(ExportStateSchema.safeParse('fetching').success).toBe(false)
  })
})
