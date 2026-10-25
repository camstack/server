/**
 * Shared shapes for the fleet-read assertions on the Notification / AI pages.
 *
 * Every one of those pages used to read the fleet through the RAW tRPC client
 * (`system.trpcClient.deviceManager.listAll.query(...)`) inside its own
 * `useQuery`, under its own single-nested key `['deviceManager','listAll',…]`.
 * Three things follow from that, and all three are invisible at the call site:
 *
 *  1. `applyFleetQueryDefaults` registers the 30 s window on the tRPC key
 *     PREFIX `[['deviceManager','listAll']]` (D274). A single-nested key does
 *     not match it, so the window never applied to these reads.
 *  2. The ~20 mutation handlers that invalidate `[['deviceManager']]` do not
 *     match it either — renaming a camera never refreshed these pickers.
 *  3. Each page fetched its own copy of a fleet the rest of the app already had
 *     warm, at 5.6 s full projection / 2.9 s slim on a 1 019-device hub.
 *
 * The assertion these types serve is therefore the REQUEST SHAPE, in three
 * parts: which client (the generated hook, never `trpcClient`), which
 * projection (`slim`), and whose window (no `staleTime` at the call site —
 * D274 owns it on the query client, and `check-fleet-query-defaults.ts` fails
 * CI on a local redeclaration).
 */

/** The `deviceManager.listAll` input schema, as a call site may express it. */
export interface FleetListInput {
  readonly addonId?: string
  readonly projection?: 'full' | 'slim'
  readonly isCamera?: boolean
  readonly deviceIds?: readonly number[]
}

/** The React Query options a call site may pass alongside the input. */
export interface FleetListOptions {
  readonly staleTime?: number
  readonly gcTime?: number
  readonly enabled?: boolean
}

/** The slice of a `DeviceInfo` row these pages read. Slim carries all of it. */
export interface FleetRow {
  readonly id: number
  readonly name: string
  readonly type?: string
  readonly stableId?: string
  readonly location?: string | null
  readonly disabled?: boolean
  readonly isCamera?: boolean
}

/** The `UseQueryResult` fields the pages consume off the generated hook. */
export interface FleetListResult {
  /** `undefined` is a query that has not answered (or failed). */
  readonly data: readonly FleetRow[] | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

/** Build the hook's answer. Defaults mirror a settled, successful query. */
export function fleetListResult(rows: readonly FleetRow[]): FleetListResult {
  return { data: rows, isLoading: false, isError: false }
}
