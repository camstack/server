/**
 * `ExportSubject` — what an export IS, as opposed to the four fields the
 * Library sorts and labels on (D558).
 *
 * Everything here is a rule that cost something to find, so each test names
 * what it prevents rather than restating the schema.
 */
import { describe, expect, it } from 'vitest'
import {
  CreateExportInputSchema,
  type ExportRecord,
  ExportRecordSchema,
  ExportSubjectSchema,
  exportSubjectOf,
  recordingExportCapability,
  resolveCreateExportSubject,
} from '../capabilities/recording-export.cap.js'

const OPTIONS = {
  speed: 1,
  includeAudio: false,
  maxLifeMs: 604_800_000,
  deleteAfterDownload: false,
} as const

const CLIP_SUBJECT = {
  kind: 'clip',
  deviceId: 107,
  provider: 'provider-reolink',
  source: 'native:reolink:onboard',
  sourceLabel: 'SD card',
  clipId: 'native:reolink:onboard:20260920_192927_000000_0',
  catalogWindow: { sinceMs: 1_758_326_400_000, untilMs: 1_758_412_800_000 },
  profile: 'low',
} as const

function clipInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { deviceId: 107, subject: CLIP_SUBJECT, options: OPTIONS, ...over }
}

function footageRecord(over: Partial<ExportRecord> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    deviceId: 101,
    profile: 'high',
    fromMs: 1_000,
    toMs: 6_000,
    options: OPTIONS,
    state: 'ready',
    progressPct: 100,
    fileBytes: 4_096,
    expiresAt: 9_999,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: 10,
    createdBy: 'operator',
    error: null,
    ...over,
  }
}

describe('ExportSubjectSchema', () => {
  it('discriminates a footage subject from a clip subject', () => {
    expect(
      ExportSubjectSchema.safeParse({
        kind: 'footage',
        deviceId: 101,
        profiles: ['high'],
        fromMs: 1,
        toMs: 2,
      }).success,
    ).toBe(true)
    expect(ExportSubjectSchema.safeParse(CLIP_SUBJECT).success).toBe(true)
  })

  it('carries no fromMs/toMs on a clip: the camera chose them and no surface asks', () => {
    // D558 § 5.4.3. A clip subject with a range would be a second place the
    // boundaries live, and the one a caller could get wrong.
    const parsed = ExportSubjectSchema.parse({ ...CLIP_SUBJECT, fromMs: 1, toMs: 2 })
    expect(parsed).not.toHaveProperty('fromMs')
    expect(parsed).not.toHaveProperty('toMs')
  })

  it('refuses `auto` as a clip profile — a stored file has no broker session', () => {
    // D549 15: `auto` is an adaptive tier resolved against a live session, and
    // a clip is a file. The surface resolves it before it asks.
    expect(ExportSubjectSchema.safeParse({ ...CLIP_SUBJECT, profile: 'auto' }).success).toBe(false)
  })

  it('requires the provider addonId — `listClips` has no default (D554 amended)', () => {
    const { provider: _dropped, ...withoutProvider } = CLIP_SUBJECT
    expect(ExportSubjectSchema.safeParse(withoutProvider).success).toBe(false)
  })

  it('takes exactly ONE profile on a clip: one tap is never two fetches', () => {
    // D558 § 5.4.2 rule 1 — two twins would be two jobs, and on a battery
    // camera two jobs are two wakes.
    expect(
      ExportSubjectSchema.safeParse({ ...CLIP_SUBJECT, profile: ['low', 'high'] }).success,
    ).toBe(false)
  })

  it('leaves the wake absent by default and accepts only the operator authorisation', () => {
    expect(ExportSubjectSchema.parse(CLIP_SUBJECT)).not.toHaveProperty('wake')
    expect(ExportSubjectSchema.safeParse({ ...CLIP_SUBJECT, wake: 'authorised' }).success).toBe(
      true,
    )
    expect(ExportSubjectSchema.safeParse({ ...CLIP_SUBJECT, wake: 'next-natural' }).success).toBe(
      false,
    )
  })
})

describe('createExport input — the subject beside the projection', () => {
  const schema = recordingExportCapability.methods.createExport.input

  it('keeps a REQUIRED top-level deviceId, because that is what per-device scope reads', () => {
    // `METHOD_DEVICE_SELECTORS` maps TOP-LEVEL fields and one-level object
    // ARRAYS — never a nested object. A `deviceId` that lived only inside
    // `subject` would be invisible to `scope-access.ts`, and a principal
    // scoped to one camera could create an export (and a WAKE) for another.
    expect(schema.safeParse({ subject: CLIP_SUBJECT, options: OPTIONS }).success).toBe(false)
  })

  it('accepts a clip subject with no time range at all', () => {
    expect(schema.safeParse(clipInput()).success).toBe(true)
  })

  it('refuses a clip subject whose deviceId disagrees with the projection', () => {
    expect(schema.safeParse(clipInput({ deviceId: 101 })).success).toBe(false)
  })

  it('refuses a time range on the clip path — there is no drag to normalise', () => {
    expect(schema.safeParse(clipInput({ fromMs: 1, toMs: 2 })).success).toBe(false)
  })

  it('still accepts the legacy flat footage input, and still survives .loose()', () => {
    const legacy = { deviceId: 101, profile: 'high', fromMs: 1, toMs: 6, options: OPTIONS }
    expect(schema.safeParse(legacy).success).toBe(true)
    expect(schema.loose().safeParse({ ...legacy, nodeId: 'hub' }).success).toBe(true)
  })

  it('CreateExportInputSchema is still the cap method input', () => {
    expect(CreateExportInputSchema).toBe(schema)
  })
})

describe('resolveCreateExportSubject — the ONE reading of an input', () => {
  it('rewrites a legacy flat input into a footage subject', () => {
    const subject = resolveCreateExportSubject(
      CreateExportInputSchema.parse({
        deviceId: 101,
        profile: 'high',
        fromMs: 1_000,
        toMs: 6_000,
        options: OPTIONS,
      }),
    )
    expect(subject).toEqual({
      kind: 'footage',
      deviceId: 101,
      profiles: ['high'],
      fromMs: 1_000,
      toMs: 6_000,
    })
  })

  it('returns the clip subject verbatim — it is the authority, not the projection', () => {
    const subject = resolveCreateExportSubject(CreateExportInputSchema.parse(clipInput()))
    expect(subject).toEqual(CLIP_SUBJECT)
  })
})

describe('exportSubjectOf — the ONE interpreter of a stored row', () => {
  it('answers a history row written before D558 with its footage projection', () => {
    // Rows are parsed by `ExportRecordSchema` on every read (`RowMapStore`), so
    // `subject` is OPTIONAL: a required field would make the whole export
    // AUDIT unreadable. Absence has exactly one meaning and exactly one reader.
    const rec = ExportRecordSchema.parse(footageRecord())
    expect(rec.subject).toBeUndefined()
    expect(exportSubjectOf(rec)).toEqual({
      kind: 'footage',
      deviceId: 101,
      profiles: ['high'],
      fromMs: 1_000,
      toMs: 6_000,
    })
  })

  it('answers a clip row with its SUBJECT, never with the mirror', () => {
    const rec = ExportRecordSchema.parse(
      footageRecord({
        deviceId: 107,
        // The projection: what the camera chose, and the twin that was SERVED.
        profile: 'high',
        fromMs: 1_758_398_967_000,
        toMs: 1_758_398_996_000,
        subject: CLIP_SUBJECT,
      }),
    )
    // `subject.profile` is what was ASKED (`low`); the top-level one is what
    // was SERVED (`high`). A reader that took the mirror for the ask would
    // lose exactly the divergence D549 15 exists to show.
    expect(exportSubjectOf(rec)).toEqual(CLIP_SUBJECT)
    expect(rec.profile).toBe('high')
  })
})
