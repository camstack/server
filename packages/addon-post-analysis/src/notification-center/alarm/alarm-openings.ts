/**
 * What "open" means to the alarm — D630's table, in one place.
 *
 * Read from the RAW runtime slices, not from the collapsed `deviceState`
 * word: the collapse is first-match over every cap, so it cannot say whether a
 * device is an opening at all, and a camera and an unreadable window would both
 * come back `undefined`.
 *
 * Three answers, never two (D49 — an unreadable state is unknown, never closed
 * and never open):
 *
 *  - `not-opening` — no opening slice at all: a camera named by an intrusion
 *    rule. It takes no part in the arm decision.
 *  - `unknown` — an opening cap's slice IS there, but its field is missing or
 *    is not a word that cap defines, or the slice is a provider's PLACEHOLDER
 *    (`lastChangedAt === 0`). It never blocks and is never armed as secure on a
 *    guess.
 *  - `reading` — open or secure, with the state word a person will read and the
 *    cap that produced it (so secure-on-arm knows what to actuate).
 *
 * A read that FAILED never reaches {@link alarmOpeningFrom}: the caller leaves
 * that id out of its answer (see {@link readAlarmOpenings}).
 *
 * Anything short of fully secure is open: a cover stopped half-way, a lock that
 * jammed, a cover still closing when the arm is decided, a switch that is on.
 *
 * PRECEDENCE, when one device carries more than one opening slice: any OPEN
 * reading wins over a secure one (a reed that says open beats a motor that
 * still says `closed`). Among opens, a controllable cap (`cover` / `lock-control`
 * / `switch`) wins so secure-on-arm knows what to actuate; among secures the
 * contact wins as the physical "closed" when the motor has not moved yet.
 */

import {
  CoverStateSchema,
  isAlarmControllableCap,
  type IScopedLogger,
  LockStateSchema,
  type NcAlarmOpeningEventKind,
} from '@camstack/types'

export type NcAlarmOpeningReading = 'open' | 'secure'

/** The caps whose slice makes a device an opening, in precedence order. */
export type NcAlarmOpeningCap = 'contact' | 'cover' | 'lock-control' | 'switch'

export type NcAlarmOpening =
  | { readonly kind: 'not-opening' }
  | { readonly kind: 'unknown'; readonly cap: NcAlarmOpeningCap; readonly raw: unknown }
  | {
      readonly kind: 'reading'
      readonly reading: NcAlarmOpeningReading
      readonly state: string
      readonly cap: NcAlarmOpeningCap
    }

type NcAlarmSliceRead =
  | { readonly kind: 'absent' }
  | Extract<NcAlarmOpening, { kind: 'unknown' } | { kind: 'reading' }>

type NcRuntimeSlices = Readonly<Record<string, unknown>>

/** The one state word, per cap, that counts as secure. Everything else is open. */
const COVER_SECURE = 'closed'
const LOCK_SECURE = 'locked'

const NOT_OPENING: NcAlarmOpening = { kind: 'not-opening' }

function sliceOf(runtime: NcRuntimeSlices, cap: NcAlarmOpeningCap): object | null | undefined {
  const slice = runtime[cap]
  if (slice === undefined) return undefined
  return slice !== null && typeof slice === 'object' ? slice : null
}

function fieldOf(slice: object | null, field: string): unknown {
  if (slice === null) return undefined
  return Object.entries(slice).find(([key]) => key === field)?.[1]
}

/** A provider's cold placeholder: nobody has read the device yet (D49 ⇒ unknown). */
function isPlaceholder(slice: object | null): boolean {
  return fieldOf(slice, 'lastChangedAt') === 0
}

function reading(word: string, secure: string, cap: NcAlarmOpeningCap): NcAlarmSliceRead {
  return {
    kind: 'reading',
    reading: word === secure ? 'secure' : 'open',
    state: word,
    cap,
  }
}

function readContact(runtime: NcRuntimeSlices): NcAlarmSliceRead {
  const slice = sliceOf(runtime, 'contact')
  if (slice === undefined) return { kind: 'absent' }
  if (isPlaceholder(slice)) return { kind: 'unknown', cap: 'contact', raw: slice }
  const raw = fieldOf(slice, 'entryOpen')
  if (typeof raw !== 'boolean') return { kind: 'unknown', cap: 'contact', raw }
  return raw
    ? { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' }
    : { kind: 'reading', reading: 'secure', state: 'closed', cap: 'contact' }
}

function readCover(runtime: NcRuntimeSlices): NcAlarmSliceRead {
  const slice = sliceOf(runtime, 'cover')
  if (slice === undefined) return { kind: 'absent' }
  if (isPlaceholder(slice)) return { kind: 'unknown', cap: 'cover', raw: slice }
  const raw = fieldOf(slice, 'state')
  const parsed = CoverStateSchema.safeParse(raw)
  return parsed.success
    ? reading(parsed.data, COVER_SECURE, 'cover')
    : { kind: 'unknown', cap: 'cover', raw }
}

function readLock(runtime: NcRuntimeSlices): NcAlarmSliceRead {
  const slice = sliceOf(runtime, 'lock-control')
  if (slice === undefined) return { kind: 'absent' }
  if (isPlaceholder(slice)) return { kind: 'unknown', cap: 'lock-control', raw: slice }
  const raw = fieldOf(slice, 'state')
  const parsed = LockStateSchema.safeParse(raw)
  return parsed.success
    ? reading(parsed.data, LOCK_SECURE, 'lock-control')
    : { kind: 'unknown', cap: 'lock-control', raw }
}

function readSwitch(runtime: NcRuntimeSlices): NcAlarmSliceRead {
  const slice = sliceOf(runtime, 'switch')
  if (slice === undefined) return { kind: 'absent' }
  if (isPlaceholder(slice)) return { kind: 'unknown', cap: 'switch', raw: slice }
  const raw = fieldOf(slice, 'on')
  if (typeof raw !== 'boolean') return { kind: 'unknown', cap: 'switch', raw }
  return raw
    ? { kind: 'reading', reading: 'open', state: 'on', cap: 'switch' }
    : { kind: 'reading', reading: 'secure', state: 'off', cap: 'switch' }
}

/** D630's table over one device's runtime slices — see the header for the three answers. */
export function alarmOpeningFrom(runtime: NcRuntimeSlices): NcAlarmOpening {
  let openControllable: Extract<NcAlarmOpening, { kind: 'reading' }> | null = null
  let openAny: Extract<NcAlarmOpening, { kind: 'reading' }> | null = null
  let secureContact: Extract<NcAlarmOpening, { kind: 'reading' }> | null = null
  let secureControllable: Extract<NcAlarmOpening, { kind: 'reading' }> | null = null
  let secureAny: Extract<NcAlarmOpening, { kind: 'reading' }> | null = null
  let firstUnknown: NcAlarmOpening | null = null
  for (const read of [
    readContact(runtime),
    readCover(runtime),
    readLock(runtime),
    readSwitch(runtime),
  ]) {
    if (read.kind === 'unknown') {
      if (firstUnknown === null) firstUnknown = read
      continue
    }
    if (read.kind !== 'reading') continue
    if (read.reading === 'open') {
      if (isAlarmControllableCap(read.cap) && openControllable === null) openControllable = read
      if (openAny === null) openAny = read
      continue
    }
    if (read.cap === 'contact' && secureContact === null) secureContact = read
    if (isAlarmControllableCap(read.cap) && secureControllable === null) secureControllable = read
    if (secureAny === null) secureAny = read
  }
  return (
    openControllable ??
    openAny ??
    secureContact ??
    secureControllable ??
    secureAny ??
    firstUnknown ??
    NOT_OPENING
  )
}

/**
 * The sensor-event kind (`CAP_TO_KIND` in `@camstack/types`) → the cap whose
 * slice the row's `value` is. Only the opening kinds; every other kind is not
 * an opening.
 */
// `satisfies`: the keys must be EXACTLY `NC_ALARM_OPENING_EVENT_KINDS`, the list
// the editors' D640 "can never fire" warning reads — a kind added here and not
// there (or the reverse) is a compile error, not a silent disagreement.
const OPENING_CAP_BY_EVENT_KIND: Readonly<Record<string, NcAlarmOpeningCap>> = {
  contact: 'contact',
  cover: 'cover',
  lock: 'lock-control',
  switch: 'switch',
} satisfies Readonly<Record<NcAlarmOpeningEventKind, NcAlarmOpeningCap>>

/**
 * The same table, read off one sensor-event row: its `value` IS the slice of
 * the cap its `kind` names, so the event path and the reconcile read answer in
 * one vocabulary — a cover is secure only when `closed`, a lock only when
 * `locked`, a switch only when off, whichever path saw it.
 */
export function alarmOpeningFromSensorEvent(
  kind: string,
  value: Readonly<Record<string, unknown>> | null,
): NcAlarmOpening {
  const cap = OPENING_CAP_BY_EVENT_KIND[kind]
  if (cap === undefined) return NOT_OPENING
  return alarmOpeningFrom({ [cap]: value })
}

/**
 * What ONE covered device contributes to an alarm decision or view, from its
 * {@link NcAlarmOpening} (or its absence). The one classifier the arm check
 * and the live view share, so the two cannot drift (D49):
 *  - absent (the read failed) or `unknown` (a word its cap does not define)
 *    ⇒ `unknown` — never open, never secure;
 *  - `not-opening`, or a secure reading ⇒ `skip`;
 *  - an open reading ⇒ `open`, with the state word and whether it is controllable.
 */
export type NcCoveredOpening =
  | { readonly kind: 'unknown'; readonly why: 'read-failed' }
  | {
      readonly kind: 'unknown'
      readonly why: 'unknown-word'
      readonly cap: NcAlarmOpeningCap
      readonly raw: unknown
    }
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'open'
      readonly state: string
      readonly controllable: boolean
      readonly cap: NcAlarmOpeningCap
    }

export function classifyCoveredOpening(opening: NcAlarmOpening | undefined): NcCoveredOpening {
  if (opening === undefined) return { kind: 'unknown', why: 'read-failed' }
  if (opening.kind === 'unknown') {
    return { kind: 'unknown', why: 'unknown-word', cap: opening.cap, raw: opening.raw }
  }
  if (opening.kind === 'not-opening' || opening.reading !== 'open') return { kind: 'skip' }
  return {
    kind: 'open',
    state: opening.state,
    controllable: isAlarmControllableCap(opening.cap),
    cap: opening.cap,
  }
}

/**
 * An `unknown` opening's `raw`, for a log line: a placeholder carries the whole
 * slice, which `String()` would flatten to `[object Object]`.
 */
export function rawForLog(raw: unknown): string {
  return raw !== null && typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
}

/** How many runtime reads `readAlarmOpenings` keeps in flight at once. */
const OPENINGS_READ_CONCURRENCY = 8

/**
 * The Notification Center's `readDeviceOpenings` dep, given the one runtime
 * read it needs. Every id that could be read is present with its
 * {@link NcAlarmOpening}; an id whose read THREW is ABSENT (unknown, D49) and
 * leaves one debug line tagged with its `deviceId`.
 */
export async function readAlarmOpenings(
  ids: readonly number[],
  loadRuntime: (deviceId: number) => Promise<NcRuntimeSlices>,
  logger: Pick<IScopedLogger, 'debug'>,
): Promise<ReadonlyMap<number, NcAlarmOpening>> {
  const out = new Map<number, NcAlarmOpening>()
  const readOne = async (id: number): Promise<void> => {
    try {
      out.set(id, alarmOpeningFrom(await loadRuntime(id)))
    } catch (err) {
      logger.debug('device-opening read failed', {
        tags: { deviceId: id },
        meta: { error: String(err) },
      })
    }
  }
  // Concurrently, in bounded chunks: an arm is a person waiting on a button,
  // and a serial walk made it the SUM of every device's round trip. Bounded so
  // a mode covering many devices is not a burst at the runtime store.
  for (let i = 0; i < ids.length; i += OPENINGS_READ_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + OPENINGS_READ_CONCURRENCY).map(readOne))
  }
  return out
}
