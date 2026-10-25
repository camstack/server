/**
 * The one place a media key is built and read.
 *
 * A media key addresses a file by its OWNER, in one grammar:
 *
 * ```
 * <ownerType>:<ownerId>:<fileKind>[:<timestampMs>]
 * ```
 *
 * The owner type is a TABLE. That is already true of every owner on the live
 * hub - `track`, `face`, `identity`, `plate` - and the exception was
 * `event`, which covered three tables at once. While event ids were UUIDs the
 * ambiguity cost nothing, because a UUID is unique across tables. D474 made an
 * event id a SQLite rowid alias, so each table numbers from 1 and `event:5`
 * stopped naming one row. Splitting `event` into `motion` / `object` / `audio`
 * restores uniqueness without a fifth segment and without a magic numbering
 * offset, which would have hidden the same invariant somewhere nobody reads.
 *
 * Why this module exists at all, rather than a `split(':')` at each call site:
 * the key is built in the addon, in `ui-library` and in the notification
 * dispatcher, and read positionally in admin-ui (`split(':')[1]` for an owner
 * id). Positional reads are silently wrong the moment a segment moves, and
 * there is no compiler that notices. It lives in `@camstack/types` because both
 * an addon and the UI packages must reach it, and addons may not import each
 * other.
 *
 * `parseMediaOwnerKey` returns `null` for anything it cannot read, and never
 * throws: it sits on the media READ path, where an exception takes out every
 * thumbnail and a guess puts the wrong image on screen. A legacy `event:` key
 * is therefore unreadable BY DESIGN - on this hub the 299 883 resolvable ones
 * are rewritten by the D474 data migration.
 *
 * The 676 that remain are NOT what this comment used to claim ("already
 * orphaned, their event having aged out before it"). Measured 2026-09-12
 * (D480): 675 are notification summary MOSAICS, filed under
 * `ownerKind: 'event'` with a synthetic `summary-<ruleId>-<windowEndMs>` owner
 * id that no event row has ever had — 271 MiB on one camera, still growing.
 * Exactly ONE is a real aged-out orphan. The retention cascade escapes 1 row
 * in 300 220, and reading this residue as "what the cascade missed" is what
 * sent D480 looking in the wrong place; read that record before trusting any
 * count here.
 */

import { z } from 'zod'

/**
 * Owner types, i.e. the tables that own media.
 *
 * `motion` / `object` / `audio` are the three event tables; `event` is
 * deliberately absent and must not be re-added - it is the ambiguity this
 * module exists to remove.
 *
 * This list must cover `OWNER_KINDS` in
 * `addon-post-analysis/src/pipeline-analytics/store/media-store.ts`, which is
 * the AUTHORITY on what may own media. I first derived it from the prefixes
 * actually present on the live hub and so omitted `vehicle` and `scene`: both
 * are declared owner kinds with no rows today, and the parser would have
 * rejected their keys the day one appeared. A list derived from data is a list
 * that is correct until the data changes.
 *
 * `summary` is gone with the session summary it named (D680): a `summary:` key
 * left on disk is unreadable by design, like a legacy `event:` one, and the
 * orphan audit reclaims its row as a retired owner.
 */
export const MEDIA_OWNER_TYPES = [
  'track',
  'face',
  'identity',
  'plate',
  'vehicle',
  'scene',
  'motion',
  'object',
  'audio',
  // The notification digest's mosaic (D480). Its owner id is the RULE id: the
  // writer bounds how many a rule keeps, so the key names a real owner instead
  // of a synthetic `summary-<ruleId>-<windowEndMs>` in a table's namespace.
  'mosaic',
] as const

export type MediaOwnerType = (typeof MEDIA_OWNER_TYPES)[number]

/** A parsed media key. `timestampMs` is absent for the three-segment form. */
export interface MediaOwnerKey {
  readonly ownerType: MediaOwnerType
  readonly ownerId: string
  readonly fileKind: string
  readonly timestampMs?: number
}

/**
 * What a caller may hand `formatMediaOwnerKey`. `ownerId` widens to `number`
 * because an event id IS a number now (D474) and stringifying at every call
 * site is how the old `String(id)` sprawl started.
 */
export interface MediaOwnerKeyInput {
  readonly ownerType: MediaOwnerType
  readonly ownerId: string | number
  readonly fileKind: string
  readonly timestampMs?: number
}

const OWNER_TYPES: ReadonlySet<string> = new Set<string>(MEDIA_OWNER_TYPES)

/** Digits only. `Number('')` is 0 and `Number(' ')` is 0, so neither is used. */
const DIGITS = /^\d+$/

/**
 * Is this string a declared media owner type?
 *
 * Exported because the `event-media` plane's path parser needs it (D482): a
 * path segment is an arbitrary string until something narrows it, and a
 * hand-written list at the door would drift from {@link MEDIA_OWNER_TYPES} the
 * day an owner kind is added — the failure this module's own docblock already
 * records for `vehicle` and `scene`.
 */
export function isMediaOwnerType(value: string): value is MediaOwnerType {
  return OWNER_TYPES.has(value)
}

/**
 * Read a media key. `null` when it is not one - an unknown owner type, a legacy
 * `event:` key, a missing segment, or a fourth segment that is not a timestamp.
 *
 * `fileKind` is returned as a plain string rather than validated against
 * `MediaFileKindEnum`: kinds have been RETIRED over time (`crop`,
 * `fullFrameBoxed`) and rows carrying them still exist, so a parser that
 * rejected them would make historical media unreadable while claiming the key
 * was malformed.
 */
export function parseMediaOwnerKey(key: string): MediaOwnerKey | null {
  const parts = key.split(':')
  if (parts.length !== 3 && parts.length !== 4) return null

  const [ownerType, ownerId, fileKind, timestamp] = parts
  if (ownerType === undefined || !isMediaOwnerType(ownerType)) return null
  if (ownerId === undefined || ownerId.length === 0) return null
  if (fileKind === undefined || fileKind.length === 0) return null

  if (timestamp === undefined) return { ownerType, ownerId, fileKind }
  if (!DIGITS.test(timestamp)) return null
  return { ownerType, ownerId, fileKind, timestampMs: Number(timestamp) }
}

/** Build a media key. The timestamp segment is omitted when there is none. */
export function formatMediaOwnerKey(key: MediaOwnerKeyInput): string {
  const head = `${key.ownerType}:${key.ownerId}:${key.fileKind}`
  return key.timestampMs === undefined ? head : `${head}:${key.timestampMs}`
}

/**
 * The owner types that are event tables, in the order the event-media resolver
 * should consider them. Exported so a consumer asking "is this key an event?"
 * does not re-spell the list and drift from it.
 */
export const EVENT_OWNER_TYPES = ['motion', 'object', 'audio'] as const

export type EventOwnerType = (typeof EVENT_OWNER_TYPES)[number]
// Pinned to `EventOwnerTypeSchema` below. Both come from `EVENT_OWNER_TYPES`,
// so they cannot drift today; the pair fails to compile the day one is widened
// and the other is not. `z.infer` is not usable here because the schema is
// declared AFTER this type in the same module and carries an explicit
// annotation — the assertion is the same rule, written where both are visible.

/**
 * The same list as a Zod enum, for the cap inputs that must NAME the table
 * (D482: `getEventMedia` / `listEventMedia` take an owner, and an owner is
 * `(table, id)`).
 *
 * Built FROM {@link EVENT_OWNER_TYPES} rather than re-spelled: a fourth event
 * table would otherwise be accepted by the codec and refused at the door, with
 * nothing failing until a caller asked.
 */
export const EventOwnerTypeSchema: z.ZodEnum<{
  motion: 'motion'
  object: 'object'
  audio: 'audio'
}> = z.enum(EVENT_OWNER_TYPES)

/** The pin promised above: either side widening alone stops compiling. */
const _eventOwnerTypeSchemaMatchesType = {} as z.infer<
  typeof EventOwnerTypeSchema
> satisfies EventOwnerType
const _eventOwnerTypeTypeMatchesSchema = {} as EventOwnerType satisfies z.infer<
  typeof EventOwnerTypeSchema
>
void _eventOwnerTypeSchemaMatchesType
void _eventOwnerTypeTypeMatchesSchema

/**
 * The owner kinds a media-PRESENCE probe may ask about: the three event tables
 * plus `track`.
 *
 * `videoclips` resolves a clip's still the way `resolveDefaultEventMedia` does
 * — the event's OWN media when it has any, else its owning TRACK's — so the
 * probe needs exactly this union and no more of {@link MediaOwnerType}. Built
 * FROM {@link EVENT_OWNER_TYPES} so a fourth event table reaches the probe the
 * day it is declared, rather than being accepted by one side and refused by the
 * other.
 */
export const MEDIA_PRESENCE_OWNER_KINDS = [...EVENT_OWNER_TYPES, 'track'] as const

export type MediaPresenceOwnerKind = (typeof MEDIA_PRESENCE_OWNER_KINDS)[number]

/** The same list as a Zod enum, for the cap input that carries it. */
export const MediaPresenceOwnerKindSchema: z.ZodEnum<{
  motion: 'motion'
  object: 'object'
  audio: 'audio'
  track: 'track'
}> = z.enum(MEDIA_PRESENCE_OWNER_KINDS)

/** The pin promised above: either side widening alone stops compiling. */
const _presenceKindSchemaMatchesType = {} as z.infer<
  typeof MediaPresenceOwnerKindSchema
> satisfies MediaPresenceOwnerKind
const _presenceKindTypeMatchesSchema = {} as MediaPresenceOwnerKind satisfies z.infer<
  typeof MediaPresenceOwnerKindSchema
>
void _presenceKindSchemaMatchesType
void _presenceKindTypeMatchesSchema

const EVENT_OWNER_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_OWNER_TYPES)

/** True when this key's owner is one of the three event tables. */
export function isEventOwnerType(ownerType: MediaOwnerType): ownerType is EventOwnerType {
  return EVENT_OWNER_TYPE_SET.has(ownerType)
}
