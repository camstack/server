/**
 * The outbox KEY — the one place a notification's dedup id is built (D694).
 *
 * An outbox row is keyed `${ruleId}:${dedupRef}:${targetId}`, and that id IS the
 * durable exactly-once guarantee: re-enqueueing the same id is a silent no-op
 * for as long as the row is inside the outbox horizon (7 days by default).
 *
 * ## Why a record id alone is not an identity
 *
 * `dedupRef` falls back to the record id when the row is not track-scoped. For
 * three kinds that record id is a SQLite ROWID (D474): an object event without a
 * track, a package event (a `package` object-event row) and a classified audio
 * event. Those tables have no `AUTOINCREMENT`, so SQLite hands out
 * `max(rowid) + 1` — and an id is REUSED as soon as the rows at the top of the
 * table are deleted. That happens here within seconds: a never-moved subject is
 * disposed (D547) while its rows are still the newest. On 2026-09-30 a deleted
 * vehicle event on one camera and a new package pick-up on another got the same
 * id 292786 within 90 s. Keyed on the id alone, the second record's notification
 * is a dedup hit on the first record's row — swallowed, silently, for 7 days.
 *
 * So a rowid record's dedup ref carries its GENERATION: the camera it belongs to
 * and its own timestamp, `<recordId>@<deviceId>:<recordAt>`. Both are facts of
 * the stored row (never of the evaluation), so the live hook and the boot
 * reconcile build the same ref for the same row, and two rows that share an id
 * cannot share both.
 *
 * Every other kind is untouched: a track id is random (`track-id.ts`), a sensor
 * event id is producer-minted TEXT, and every synthetic record id (audio window,
 * occupancy, timelapse, summary, alert episode, system event) already spells
 * its device and its instant. Changing their keys would only cost the horizon.
 *
 * ## Rows written before D694
 *
 * A row already in the store keeps its id (the drain rewrites it by that id), and
 * its record is re-identified from the row itself — `deviceId` is a column and
 * the record's timestamp is frozen in `payload.subject.timestamp`. Two helpers
 * cover the two ways the outbox meets such a row:
 *
 *  - {@link translatedLegacyEntryId} — at hydrate, the id the row WOULD have
 *    today, added to the dedup horizon beside its stored id;
 *  - {@link legacyOutboxEntryId} + {@link isSameOutboxRecord} — while the horizon
 *    is still cold, a store probe of the old spelling that is accepted ONLY when
 *    the row found is the same record (an old row of a DIFFERENT record that
 *    reused the id is exactly the collision this module exists to stop).
 *
 * Anything that builds, compares or probes an outbox id goes through this
 * module. A second spelling elsewhere is how the two would drift.
 */

import type { NcOutboxPayload, NcOutboxRecordKind } from './outbox.js'

/**
 * The record kinds whose `recordId` is a per-table SQLite rowid (D474), and so
 * may be reused after a delete. `device-event` is NOT one: sensor events are
 * TEXT-keyed with a producer-minted id (`sensor-event-store.ts`).
 */
const ROWID_RECORD_KINDS: ReadonlySet<NcOutboxRecordKind> = new Set<NcOutboxRecordKind>([
  'object-event',
  'package-event',
  'audio-event',
])

/** Is this kind's record id a reusable rowid? See {@link ROWID_RECORD_KINDS}. */
function isRowidRecordKind(kind: NcOutboxRecordKind): boolean {
  return ROWID_RECORD_KINDS.has(kind)
}

/**
 * Which RECORD a row speaks for — the stored id plus the two facts that tell
 * two holders of one reused rowid apart.
 */
export interface NcOutboxRecordIdentity {
  readonly recordId: string
  /** The camera the record belongs to (the outbox row's `deviceId` column). */
  readonly deviceId: number
  /** The record's OWN timestamp (`payload.subject.timestamp` on the row). */
  readonly recordAt: number
}

/** Everything an outbox id is built from. Satisfied structurally by both
 *  `NcOutboxEnqueueInput` and a hydrated `NcOutboxEntry`. */
export interface NcOutboxKeyInput {
  readonly ruleId: string
  readonly targetId: string
  readonly deviceId: number
  readonly recordKind: NcOutboxRecordKind
  readonly recordId: string
  readonly trackId?: string
  /**
   * An explicit dedup ref — a grouped window's `windowKey` (D692), or a reminder's
   * `<subject>:<since>:r<n>`. Wins over everything below.
   */
  readonly dedupRef?: string
  readonly payload: { readonly subject: { readonly timestamp: number } }
}

/** The record identity an outbox key input speaks for. */
export function outboxRecordIdentity(
  input: Pick<NcOutboxKeyInput, 'recordId' | 'deviceId' | 'payload'>,
): NcOutboxRecordIdentity {
  return {
    recordId: input.recordId,
    deviceId: input.deviceId,
    recordAt: input.payload.subject.timestamp,
  }
}

/**
 * The record GENERATION ref — `<recordId>@<deviceId>:<recordAt>`. Exported for
 * the specs and for a caller that must name a rowid record outside the outbox
 * (none today); a key is always built through {@link outboxEntryId}.
 */
function recordGenerationRef(record: NcOutboxRecordIdentity): string {
  return `${record.recordId}@${String(record.deviceId)}:${String(record.recordAt)}`
}

/**
 * The middle segment of the dedup id:
 *
 *  1. an explicit `dedupRef` (a grouped window's `windowKey`, a reminder's ref);
 *  2. the track id — `maxPerTrack: 1` (a track id is random, never reused);
 *  3. for a rowid record, its generation ref;
 *  4. the record id as is (synthetic ids already carry device + instant).
 */
function outboxDedupRef(input: NcOutboxKeyInput): string {
  if (input.dedupRef !== undefined) return input.dedupRef
  if (input.trackId !== undefined) return input.trackId
  if (isRowidRecordKind(input.recordKind)) {
    return recordGenerationRef(outboxRecordIdentity(input))
  }
  return input.recordId
}

/** The outbox row id — the durable per-track / per-record fire guarantee. */
export function outboxEntryId(input: NcOutboxKeyInput): string {
  return `${input.ruleId}:${outboxDedupRef(input)}:${input.targetId}`
}

/**
 * The id this input had BEFORE D694 — but only when it differs from today's,
 * i.e. for a rowid record keyed on its record id. `null` otherwise: there is no
 * older spelling to look for.
 */
export function legacyOutboxEntryId(input: NcOutboxKeyInput): string | null {
  if (input.dedupRef !== undefined || input.trackId !== undefined) return null
  if (!isRowidRecordKind(input.recordKind)) return null
  return `${input.ruleId}:${input.recordId}:${input.targetId}`
}

/**
 * A STORED row's id as it would be built today, when the row was written under
 * the pre-D694 spelling; `null` when the stored id is already current (or was
 * built from an explicit dedup ref, which a row does not record and which never
 * involved the record id).
 */
export function translatedLegacyEntryId(storedId: string, row: NcOutboxKeyInput): string | null {
  const legacy = legacyOutboxEntryId(row)
  if (legacy === null || legacy !== storedId) return null
  return outboxEntryId(row)
}

/** What `NcOutbox.supersede` drops: one rule's pending rows for ONE record, to the named targets. */
export interface NcOutboxSupersedeInput extends NcOutboxRecordIdentity {
  readonly ruleId: string
  readonly targetIds: readonly string[]
}

/**
 * Does a STORED row's payload really carry its record timestamp?
 *
 * The type says it always does, but a stored payload is checked only as an
 * object on the way back from the store (`rowToEntry`), so a malformed or very
 * old row can lack `subject`. Every read of {@link outboxRecordIdentity} on a
 * STORED row is preceded by this check. Takes the payload as `unknown` on
 * purpose: the static type cannot answer the question.
 */
export function hasRecordTimestamp(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || !('subject' in payload)) return false
  const subject = payload.subject
  return (
    typeof subject === 'object' &&
    subject !== null &&
    'timestamp' in subject &&
    typeof subject.timestamp === 'number'
  )
}

/** Do two rows speak for the same RECORD? Id, camera and record timestamp. */
export function isSameOutboxRecord(a: NcOutboxRecordIdentity, b: NcOutboxRecordIdentity): boolean {
  return a.recordId === b.recordId && a.deviceId === b.deviceId && a.recordAt === b.recordAt
}

/**
 * Which GENERATION of an event id a media read is about: the camera the event
 * belongs to and the event's own timestamp.
 *
 * An event-owned (`object`) media row is keyed by the event's rowid, which a
 * deleted record hands to the next insert (D474) — so `object:<id>` alone can
 * name another record's crops, or crops a failed delete left behind for the
 * next holder of the id. Its only writer (`event-media-dispatcher.ts`
 * `writeEventMedia`) stamps every row with the camera and the event's own
 * timestamp, so the generation selects exactly the rows written for THIS
 * record. A track-owned read needs none: a track id is random.
 */
export interface NcEventMediaScope {
  readonly deviceId: number
  readonly recordAt: number
}

/**
 * The scope of the event a payload's `eventId` names.
 *
 * Usually the row's own subject. A COMBINED alarm row is the exception: its
 * subject is the alarm transition (its own instant), while its `eventId` is the
 * triggering rule's event — so the generation is the alarm SOURCE's camera and
 * timestamp (`NcRuleFireRef`), never the transition's.
 */
export function eventMediaScopeOf(subject: NcOutboxPayload['subject']): NcEventMediaScope {
  const source = subject.systemEvent?.alarmSource
  if (source !== undefined) return { deviceId: source.deviceId, recordAt: source.timestamp }
  return { deviceId: subject.deviceId, recordAt: subject.timestamp }
}
