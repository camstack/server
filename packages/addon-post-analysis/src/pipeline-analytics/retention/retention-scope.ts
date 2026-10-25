/**
 * Which devices one retention pass covers.
 *
 * ## Why this is its own module
 *
 * It was four lines inside the addon whose doc comment said *"every camera the
 * hub knows plus any device that still has persisted tracks"* while the code
 * said `listAll.query({})` — the WHOLE fleet, unfiltered and in the full
 * projection. On the live hub that is 967 devices against ~36 cameras, and the
 * sweep asks each of them ten questions.
 *
 * Measured, 2026-08-25, one 7-minute call-site census across one pass
 * (`store/read-census.ts`):
 *
 * | reads | call site |
 * | --- | --- |
 * | 967 | `deviceRetentionCutoffs < resolveCutoffMs < sweepTrackRetention` |
 * | 967 | `deviceRetentionCutoffs < resolveCutoffs < sweepTracklessRoots` |
 * | 967 | `purgeStoredSuggestionThreshold` |
 * | 966 | `migrateRetiredRetentionSettings` |
 * | 967 | `TrackStore.listIdsBefore` — **0 rows** |
 * | 967 | `TrackStore.countStaging` |
 * | 967 | `TrackStore.countFavourited` — **0 rows** |
 * | 967 | `SensorEventStore.evictBefore` — **0 rows** |
 * | 1934 | `EventStore.collectIds` (motion + audio) — 488 rows |
 *
 * Plus the fleet listing itself, which in the FULL projection costs
 * `device-queries.ts#listAll` one `readDeviceStore` per row — another 967.
 * Roughly ten thousand reads every five minutes to delete nothing, because a
 * door sensor has never had an analytics track and never will.
 *
 * ## Why the camera filter is safe
 *
 * The set is a UNION of three reads (cameras, tracked devices, devices holding
 * event rows — D871), and the second half is the authority for anything the
 * first half cannot name: `listTrackedDeviceIds` is the track store's own
 * grouped index, so a camera that was DELETED — the one case where "is it a
 * camera today" is the wrong question — still ages out. Narrowing the
 * device-manager half therefore cannot drop a device that owns data; it only
 * stops asking the 931 devices that own none.
 *
 * The filtering and the projection are BOTH server-side. Asking for the fleet
 * and filtering here would keep paying `listAll`'s per-row settings read, which
 * is the larger half of the cost and the half that is invisible from this
 * process.
 */

/**
 * The listing this pass asks the device manager for, and the only one it may.
 *
 * It lives HERE, next to the reasoning and inside what the spec drives, rather
 * than at the call site: the previous version of this query was a bare
 * `listAll.query({})` sitting under a comment that described this one, and
 * nothing anywhere could tell they had diverged. A test that asserted the
 * caller's shape would not have caught it either — it would have been written
 * against the code as found.
 *
 * `isCamera` cuts 967 devices to ~36. `projection: 'slim'` cuts what each of
 * those rows costs: without it `device-queries.ts#listAll` materialises
 * `config` with one sequential `readDeviceStore` per returned row, which is a
 * bill this process cannot see and therefore never accounted for.
 */
const RETENTION_FLEET_QUERY = { isCamera: true, projection: 'slim' } as const

/** The single row field the scope reads. Declared so the query above can be
 *  narrowed further without a second place needing to agree. */
export interface RetentionFleetRow {
  readonly id: number
}

/** What the scope needs from the rest of the world. Both halves are counted
 *  reads, which is why they are injected rather than reached for. */
export interface RetentionScopeDeps {
  /** The device manager's `listAll`, called with {@link RETENTION_FLEET_QUERY}
   *  and nothing else. */
  listAll(input: typeof RETENTION_FLEET_QUERY): Promise<readonly RetentionFleetRow[]>
  /** Devices with persisted tracks — includes cameras the hub no longer has. */
  listTrackedDeviceIds(): Promise<readonly number[]>
  /**
   * Devices that hold motion / audio / object EVENT rows (D871). A device that
   * is not a camera today and owns no track — a deleted one, a microphone, a
   * sensor — was in neither half above, so its terminal-root events were never
   * swept: 36k audio and 70k motion rows older than the oldest track on the
   * live hub. Optional so an older caller keeps compiling; production always
   * passes it.
   */
  listEventDeviceIds?(): Promise<readonly number[]>
}

/** How long {@link memoEventDeviceIds} reuses one answer. */
const EVENT_DEVICE_SCOPE_TTL_MS: number = 60 * 60 * 1000

/**
 * Wrap the event-holding device read so the (grouped, whole-table) read runs
 * at most once per {@link EVENT_DEVICE_SCOPE_TTL_MS}, not on every five-minute
 * pass: a device that starts holding events is swept at the next refresh, and
 * the window it is swept on is the same one the tracks use. A failed read
 * keeps the previous answer (and throws only when there is none), so a flaky
 * read never narrows the sweep.
 */
export function memoEventDeviceIds(
  read: () => Promise<readonly number[]>,
  now: () => number = Date.now,
  ttlMs: number = EVENT_DEVICE_SCOPE_TTL_MS,
): () => Promise<readonly number[]> {
  let held: { readonly ids: readonly number[]; readonly at: number } | null = null
  return async () => {
    const t = now()
    if (held !== null && t - held.at < ttlMs) return held.ids
    try {
      const ids = await read()
      held = { ids, at: t }
      return ids
    } catch (err) {
      if (held !== null) return held.ids
      throw err
    }
  }
}

/**
 * The union, deduped.
 *
 * Each half is best-effort on its own: an unreachable device manager must not
 * stop the sweep from aging out what the track store can still name, and vice
 * versa. Failing the whole pass because one half is down would mean a hub that
 * stops deleting during exactly the incident that makes it fall behind.
 */
export async function retentionScopeDeviceIds(
  deps: RetentionScopeDeps,
  onError: (half: string, err: unknown) => void,
): Promise<readonly number[]> {
  const ids = new Set<number>()
  try {
    for (const row of await deps.listAll(RETENTION_FLEET_QUERY)) ids.add(row.id)
  } catch (err) {
    onError('cameras', err)
  }
  try {
    for (const id of await deps.listTrackedDeviceIds()) ids.add(id)
  } catch (err) {
    onError('tracked', err)
  }
  if (deps.listEventDeviceIds !== undefined) {
    try {
      for (const id of await deps.listEventDeviceIds()) ids.add(id)
    } catch (err) {
      onError('events', err)
    }
  }
  return [...ids]
}
