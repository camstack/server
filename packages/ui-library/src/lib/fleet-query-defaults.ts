/**
 * Fleet-list query defaults — the ONE owner of the `deviceManager.listAll`
 * caching window (D274).
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `staleTime` is a per-OBSERVER setting in React Query, not a property of the
 * cache entry. `defaultQueryOptions` resolves it once per mounted observer as
 *
 *   { ...defaultOptions.queries, ...getQueryDefaults(queryKey), ...callSite }
 *
 * so a single observer that leaves `staleTime` at the app-wide default of `0`
 * re-triggers a fetch of the shared key on mount, no matter what its ~40
 * siblings passed. The admin UI mounts the fleet list from the sidebar, the
 * Devices page, Integrations, Recordings, Scenes, Retrain, the detection
 * sections and four ui-library pickers at once — on a hub with 1017 devices
 * that is one `deviceManager.listAll` round-trip per forgetful call site, at
 * every boot.
 *
 * The previous attempt fixed this by hand at the call site, 25 times. It had
 * already drifted before this file existed: every ui-library composite was
 * missed, and those are the ones asking for the UNPROJECTED fleet.
 *
 * ── Why the query client and not the call site ─────────────────────────────
 * `setQueryDefaults` keys off a query-key PREFIX, so one registration covers
 * every `input` variant of the method — `{}`, `{ projection: 'slim' }`,
 * `{ isCamera: true, projection: 'slim' }`, and whatever call site 44 invents.
 * It sits ABOVE the call site in the merge order, so it cannot be forgotten;
 * it sits BELOW an explicit option, so a call site that genuinely needs
 * something else (a `refetchInterval`) still gets it.
 *
 * `scripts/check-fleet-query-defaults.ts` keeps both halves honest: every
 * `QueryClient` in the admin UI and ui-library must run through here, and no
 * call site may re-declare the window locally.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'

/**
 * The tRPC query-key PREFIX shared by every `deviceManager.listAll` observer.
 * tRPC v11 builds `[[path], { input, type }]`, and `partialMatchKey` treats a
 * shorter key as a prefix — so this matches all inputs, and only this method.
 */
export const FLEET_LIST_QUERY_KEY: QueryKey = [['deviceManager', 'listAll']]

/**
 * 30 s, matching the window `GlobalSearch` established and the 21 call sites
 * that copied it — this registration replaces them rather than competing with
 * them.
 *
 * It is not longer for one reason: device mutations invalidate
 * `[['deviceManager']]` (~20 call sites do, and the prefix covers `listAll`
 * under every input), so an operator EDIT is never the thing this window makes
 * stale. What it does bound is the change no client mutation announces — a
 * provider discovering a camera, a device going offline, a scan adding rows.
 * Nothing invalidates those, so the window is the only thing that picks them
 * up, and 30 s is the cost an operator will tolerate for a row that appeared
 * on its own.
 */
export const FLEET_LIST_STALE_TIME_MS = 30_000

/**
 * 5 min. The app-wide default is `gcTime: 0` (a deliberate "no cross-navigation
 * cache" choice), which drops the entry the instant its last observer
 * unmounts — and that would make the `staleTime` above inert for every key
 * without a permanently-mounted reader. `{ projection: 'slim' }` has one (the
 * sidebar search); `{ isCamera: true, … }` and `{}` do not, so leaving `gcTime`
 * at 0 would refetch the whole fleet on every return to Recordings or Scenes.
 *
 * Scoped to this one key: the fleet list is the largest and most re-read
 * response in the UI, and it is comprehensively invalidated. The global
 * default is untouched.
 */
export const FLEET_LIST_GC_TIME_MS: number = 5 * 60_000

/**
 * Register the fleet-list window on a query client. Call this on EVERY
 * `QueryClient` that can mount a fleet consumer, immediately after
 * construction — the guard enforces it.
 */
export function applyFleetQueryDefaults(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(FLEET_LIST_QUERY_KEY, {
    staleTime: FLEET_LIST_STALE_TIME_MS,
    gcTime: FLEET_LIST_GC_TIME_MS,
  })
}
