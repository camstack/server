/**
 * Reads by id resolve aliases (D683 §6.6). The method list is DERIVED from
 * each cap's method schemas: any method whose input object has a `trackId`
 * or `trackIds` key is wrapped, so a method added later is covered without
 * anyone remembering this file.
 *
 * Fix round 1 (review H1/H2/M1):
 *  - H1: a method can carry a SECOND track reference next to `trackId`
 *    (`setTrackRelation`/`clearTrackRelation`'s `otherTrackId`).
 *    `resolveInput` now resolves every key that is `trackId`/`otherTrackId`
 *    -shaped by SUFFIX (`*TrackId`), not a hard-coded two-key list, so a
 *    future third reference is covered the same way.
 *  - H2: an alias-store lookup failure must never turn a read that used to
 *    succeed into a thrown error (D315) — every `resolve`/`resolveMany` call
 *    below is wrapped so a rejection degrades to "treat the id as its own"
 *    and is reported once via the caller's `onFailure`.
 *  - M1: a `trackIds` array batches through a caller-supplied `resolveMany`
 *    (one query per page) instead of one `resolve` call per id.
 *
 * Fix round 2: `pipelineAnalytics.ownersWithMedia`'s `ownerIds` is a
 * DISCRIMINATED field — a track id only when its sibling `ownerKind ===
 * 'track'`, an event id for every other kind. No naming-convention sweep
 * (not even a suffix one) can tell those apart from the key name alone, so
 * this is NOT folded into `resolveInput`'s heuristic — it is its own
 * declared resolver, {@link resolveTrackOwnerIds}, called explicitly only on
 * the `'track'` branch.
 */
import { z } from 'zod'

export type CapMethodInputs = Readonly<Record<string, { readonly input: z.ZodType }>>

export function trackIdTakingMethods(methods: CapMethodInputs): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [name, m] of Object.entries(methods)) {
    if (
      m.input instanceof z.ZodObject &&
      ('trackId' in m.input.shape || 'trackIds' in m.input.shape)
    )
      out.add(name)
  }
  return out
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * True for every input key a fused id can hide behind: the literal
 * `trackId`, and any SIBLING reference the schema names with the same
 * suffix (`otherTrackId` on `setTrackRelation`/`clearTrackRelation` is the
 * one that exists today — review H1). Generic by suffix, not a hard-coded
 * pair, so a future second-id field is covered without a review catching it
 * again.
 */
function isSingularTrackIdKey(key: string): boolean {
  return key === 'trackId' || (key !== 'TrackId' && key.endsWith('TrackId'))
}

function isPluralTrackIdsKey(key: string): boolean {
  return key === 'trackIds' || (key !== 'TrackIds' && key.endsWith('TrackIds'))
}

/**
 * Failure context for a sampled WARN (review H2) — whatever the caller can
 * supply. `deviceId` is omitted when the input the resolution ran against
 * carried none (D315: unknown stays unknown, never a guessed 0).
 */
export interface AliasResolveFailure {
  readonly method: string
  readonly id: string
  readonly deviceId?: number
  readonly error: unknown
}

type OnAliasResolveFailure = (failure: AliasResolveFailure) => void

const noopOnFailure: OnAliasResolveFailure = () => {}

/**
 * Bounded-memo sampling (review H2) — the same `Set` + max + `.clear()`
 * shape the NC dispatcher's `reportedAnnotatedFallbacks` already uses: a
 * persistent alias-store outage must log ONCE per (method, id) rather than
 * once per call, or a failing resolve on a hot read turns into a log flood.
 * Keyed by `method:id` so two different methods failing on the same id are
 * both visible.
 */
export function sampledOnce(max: number, onFailure: OnAliasResolveFailure): OnAliasResolveFailure {
  const reported = new Set<string>()
  return (failure) => {
    const key = `${failure.method}:${failure.id}`
    if (reported.has(key)) return
    if (reported.size >= max) reported.clear()
    reported.add(key)
    onFailure(failure)
  }
}

function inputDeviceId(input: Readonly<Record<string, unknown>>): number | undefined {
  const d = input['deviceId']
  return typeof d === 'number' ? d : undefined
}

/**
 * Resolves one id, falling back to the id ITSELF (not `null`) when `resolve`
 * throws — an alias-store RPC hiccup must never turn a read that used to
 * succeed into a thrown error for an id that was never aliased in the first
 * place (review H2 / D315). `null` (genuinely "not an alias") is the
 * expected, silent case; a THROWN rejection is reported once via `onFailure`
 * and otherwise swallowed.
 */
async function safeResolveOne(
  id: string,
  resolve: (id: string) => Promise<string | null>,
  onFailure: (id: string, err: unknown) => void,
): Promise<string> {
  try {
    return (await resolve(id)) ?? id
  } catch (err) {
    onFailure(id, err)
    return id
  }
}

/**
 * Same fallback discipline as {@link safeResolveOne}, batched (review M1):
 * `resolveMany` is handed the WHOLE array in one round trip; anything it
 * could not resolve — including everything, on a total failure — answers
 * "treat it as its own id".
 */
async function safeResolveMany(
  ids: readonly string[],
  resolveMany: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  onFailure: (id: string, err: unknown) => void,
): Promise<ReadonlyMap<string, string>> {
  try {
    return await resolveMany(ids)
  } catch (err) {
    for (const id of ids) onFailure(id, err)
    return new Map()
  }
}

async function resolveInput(
  input: unknown,
  resolve: (id: string) => Promise<string | null>,
  resolveMany: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  method: string,
  onFailure: OnAliasResolveFailure,
): Promise<unknown> {
  if (!isRecord(input)) return input
  const deviceId = inputDeviceId(input)
  const reportFailure = (id: string, err: unknown): void =>
    onFailure({ method, id, ...(deviceId !== undefined ? { deviceId } : {}), error: err })

  let next: Readonly<Record<string, unknown>> = input
  for (const key of Object.keys(input)) {
    if (!isSingularTrackIdKey(key)) continue
    const value = input[key]
    if (typeof value === 'string') {
      next = { ...next, [key]: await safeResolveOne(value, resolve, reportFailure) }
    }
  }
  for (const key of Object.keys(input)) {
    if (!isPluralTrackIdsKey(key)) continue
    const value = input[key]
    if (isStringArray(value) && value.length > 0) {
      const resolved = await safeResolveMany(value, resolveMany, reportFailure)
      next = { ...next, [key]: [...new Set(value.map((id) => resolved.get(id) ?? id))] }
    }
  }
  return next
}

/** Batches every id of a `trackIds` array through one `resolve` call each —
 *  the fallback used when a caller supplies no `resolveMany` (keeps the
 *  3-argument call signature working exactly as before review round 1). */
function resolveManyViaResolve(
  resolve: (id: string) => Promise<string | null>,
): (ids: readonly string[]) => Promise<ReadonlyMap<string, string>> {
  return async (ids) => {
    const out = new Map<string, string>()
    await Promise.all(
      ids.map(async (id) => {
        const r = await resolve(id)
        if (r !== null) out.set(id, r)
      }),
    )
    return out
  }
}

export interface ResolvingTrackIdsOptions {
  /** Batched resolution for a `trackIds`/`*TrackIds` array (review M1) — one
   *  query per page instead of one per id. Falls back to per-id `resolve`
   *  calls (the pre-fix behaviour) when omitted. */
  readonly resolveMany?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>
  /** Sampled failure report (review H2) — called at most once per failing
   *  lookup; the caller decides how/whether to log it. Defaults to a no-op. */
  readonly onFailure?: OnAliasResolveFailure
}

/**
 * Wraps every method named in `methods` so the id(s) its input carries are
 * resolved to their survivor BEFORE the implementation sees them — a method
 * added later that is not in `methods` passes through untouched, and a
 * method added later whose schema gains a `trackId`/`trackIds`-shaped key is
 * covered automatically once `methods` is re-derived from the cap (callers
 * derive it with {@link trackIdTakingMethods}, never list it by hand).
 *
 * A resolution failure never reaches the implementation as a thrown error
 * (review H2): the id is used as asked, and the failure is reported via
 * `options.onFailure`.
 */
export function resolvingTrackIds<T extends object>(
  impl: T,
  methods: ReadonlySet<string>,
  resolve: (id: string) => Promise<string | null>,
  options?: ResolvingTrackIdsOptions,
): T {
  const resolveMany = options?.resolveMany ?? resolveManyViaResolve(resolve)
  const onFailure = options?.onFailure ?? noopOnFailure
  return new Proxy(impl, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || !methods.has(prop) || typeof value !== 'function')
        return value
      return async (input: unknown, ...rest: unknown[]) =>
        Reflect.apply(value, target, [
          await resolveInput(input, resolve, resolveMany, prop, onFailure),
          ...rest,
        ])
    },
  })
}

/**
 * Carried obligation from the Task 18 review (M4): the Notification Center
 * reads media IN-PROCESS by `track:<absorbedId>` — `getMediaForOwner` in
 * `pipeline-analytics/index.ts`, called from `resolveAttachment` in
 * `notification-center/dispatcher.ts`. That call never crosses a cap
 * boundary, so {@link resolvingTrackIds} above does not cover it. A delivery
 * that resolves after the fusion re-point (recognition wait, outbox retry, AI
 * narration) must still find the survivor's scene stills, not an absorbed id
 * that now owns nothing.
 *
 * Only a `'track'` owner can ever be a fused provisional id — an `'object'`
 * event id is never an alias target, so it is returned unchanged without
 * calling `resolve` at all.
 *
 * A resolution failure never throws (review H2): the owner id is used as
 * asked, and the failure is reported via `onFailure`, labelled with `method`
 * (which in-process read called this — `getMediaForOwner` or
 * `readOwnerThumbnail`, so the two paths the review listed stay
 * distinguishable in a log line).
 */
export async function resolveMediaOwnerId(
  ownerKind: 'object' | 'track',
  ownerId: string,
  resolve: (id: string) => Promise<string | null>,
  onFailure: OnAliasResolveFailure = noopOnFailure,
  method = 'resolveMediaOwnerId',
): Promise<string> {
  if (ownerKind !== 'track') return ownerId
  return safeResolveOne(ownerId, resolve, (id, err) => onFailure({ method, id, error: err }))
}

/**
 * Fix round 2 — `pipelineAnalytics.ownersWithMedia`'s `'track'` branch.
 *
 * `ownerIds` there is the media-PRESENCE probe's input: `videoclips`
 * (`resolveVouchedEvents` in `videoclips-provider.ts`) asks "does any of
 * these tracks have footage" using ids it read off its OWN event rows
 * (`event.trackId`) — ids that can be an ABSORBED provisional id the fusion
 * has since re-pointed. The probe must still find the survivor's media, but
 * the caller looks the answer up BY THE ID IT ASKED WITH
 * (`trackMedia.has(trackId)`, that same `event.trackId`) — so the answer
 * has to come back keyed by the asked id, never the resolved one.
 *
 * Returns a complete map (every `askedIds` entry present) from the asked id
 * to the id to actually PROBE media presence with: its survivor when one
 * exists, itself otherwise (review H2: a failed lookup falls back to the
 * id as asked, same as every other path here, reported once via
 * `onFailure`). Two asked ids absorbed into the SAME survivor both map to
 * that one survivor id, so a caller that then dedupes probe ids before
 * querying (as `ownersWithMedia` does) still answers BOTH asked ids
 * present when that survivor has media.
 */
export async function resolveTrackOwnerIds(
  askedIds: readonly string[],
  resolveMany: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  onFailure: OnAliasResolveFailure = noopOnFailure,
): Promise<ReadonlyMap<string, string>> {
  const resolved = await safeResolveMany(askedIds, resolveMany, (id, err) =>
    onFailure({ method: 'ownersWithMedia', id, error: err }),
  )
  return new Map(askedIds.map((id) => [id, resolved.get(id) ?? id]))
}
