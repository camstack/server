/**
 * One refresh in flight, at most one more queued.
 *
 * For work that rebuilds a WHOLE snapshot from an event that says "something
 * changed". Such a rebuild is idempotent and total — the tenth one in a burst
 * produces exactly what the first one would have, only later — so running it
 * once per event is pure waste, and the waste scales with the fleet.
 *
 * The measured case: `AddonRegistryService`'s device-parent/meta mirror is
 * subscribed to `DeviceRegistered`, `DeviceMetaChanged`, `DeviceUnregistered`
 * and `DeviceProvisioned`, and each one ran a full-fleet
 * `deviceManager.listAll({ projection: 'slim' })`. A 974-device boot fires
 * those events once per device, so the hub rebuilt a 974-row mirror ~1 000
 * times, and every rebuild read and `JSON.parse`d the 625 KB persisted blob on
 * hub-main's event loop — the loop every runner's UDS request waits on.
 *
 * **No timer, and therefore no added latency.** A debounce would delay the
 * FIRST refresh, and this mirror backs scope enforcement — a grant on a camera
 * reaching its accessory children — so it must not be made lazier. Instead the
 * first call runs immediately; anything arriving while it runs collapses into
 * a single follow-up that starts the moment it finishes. The last event in a
 * burst is therefore always followed by a complete refresh, which is the
 * property that matters: the burst self-limits to however many rebuilds
 * actually fit in its own duration.
 *
 * ## ⚠ "fit in its own duration" is not a bound — read this before trusting it
 *
 * That last sentence is the gate's whole limitation, and it cost a second
 * measurement to see. **The gate bounds CONCURRENCY, not RATE.** The follow-up
 * starts the instant the previous run ends, so a burst that keeps producing
 * events for two minutes produces rebuilds for two minutes: the census on the
 * live hub, 2026-08-27, still measured **4 904 full-fleet reads and 4 987 368
 * rows in a 120-second boot** at this exact call site — one per event, gate
 * included, because at boot the events arrive slower than a rebuild takes.
 *
 * What actually bounds it is {@link RefreshScope}: the run is told WHICH
 * devices changed, so one device's event costs one row instead of a thousand,
 * and only a warm reads the fleet. A gate in front of a total rebuild is a
 * concurrency fix; making the rebuild not total is the cost fix. See
 * `device-meta-mirror.ts`.
 *
 * A rejection is absorbed by `run` itself (the caller owns its failure
 * policy); the gate only guarantees it does not wedge — a thrown refresh still
 * releases the slot and still honours a pending request.
 */
/**
 * WHAT a refresh has to cover: a set of device ids, or `null` for everything.
 *
 * The gate collapses requests; it must never NARROW one while doing so. Two
 * requests that arrive during the same run become their UNION, and a `null`
 * absorbs any set — widening a collapsed run is always safe, narrowing it
 * silently drops the very event that asked for it.
 */
export type RefreshScope = ReadonlySet<number> | null

export interface SingleFlightRefresh {
  /** Request a refresh covering `scope`. Returns when THIS request has been
   *  satisfied — by the run it started, or by the follow-up it collapsed into.
   *  An EMPTY set is a request for nothing and runs nothing, the same contract
   *  `listFleet({ deviceIds: [] })` states one layer down. */
  request(scope: RefreshScope): Promise<void>
}

/** Union of two scopes. `null` (everything) absorbs. */
function widenScope(a: RefreshScope, b: RefreshScope): RefreshScope {
  if (a === null || b === null) return null
  const out = new Set<number>(a)
  for (const id of b) out.add(id)
  return out
}

/**
 * @param run the rebuild, given the scope it must cover. Never called
 *   concurrently with itself, and never called with an empty set.
 */
export function createSingleFlightRefresh(
  run: (scope: RefreshScope) => Promise<void>,
): SingleFlightRefresh {
  let inFlight: Promise<void> | null = null
  // The union of everything requested while a run is active — `undefined` when
  // nothing is pending. One accumulator, not a queue: N requests during one run
  // need exactly ONE follow-up between them, because the follow-up reads the
  // world as it is when it starts.
  let pendingScope: RefreshScope | undefined
  let pendingPromise: Promise<void> | null = null
  let releasePending: () => void = () => {}

  const start = (scope: RefreshScope): Promise<void> => {
    const active = (async (): Promise<void> => {
      try {
        await run(scope)
      } finally {
        inFlight = null
        if (pendingScope !== undefined) {
          const next = pendingScope
          pendingScope = undefined
          const release = releasePending
          releasePending = () => {}
          pendingPromise = null
          // Chain the follow-up, then settle everyone who waited for it.
          void start(next).finally(release)
        }
      }
    })()
    inFlight = active
    return active
  }

  return {
    request: async (scope: RefreshScope): Promise<void> => {
      if (scope !== null && scope.size === 0) return
      if (inFlight === null) {
        await start(scope)
        return
      }
      pendingScope = pendingScope === undefined ? scope : widenScope(pendingScope, scope)
      if (pendingPromise === null) {
        pendingPromise = new Promise<void>((resolve) => {
          releasePending = resolve
        })
      }
      // `pendingPromise` is non-null whenever a scope is pending; the local
      // binding keeps that visible to the type checker after the await.
      const wait = pendingPromise
      if (wait !== null) await wait
    },
  }
}
