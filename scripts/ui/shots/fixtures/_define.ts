/**
 * The fixture-file contract for `npm run ui:shots`.
 *
 * One file per admin area: `scripts/ui/shots/fixtures/<area>.ts`, default
 * export `defineFixtures({ area, description, handlers })`. A handler key is
 * a tRPC path (`auth.listSessions`) for a query, or `mut:<path>` for a
 * mutation; the value is the answer, or a function of the call input. Return
 * `{ __error: 'message' }` to make the call fail. Files starting with `_` are
 * helpers, not areas. `shell.ts` (the app frame: nav, topology, addons,
 * capabilities) is always loaded after the selected areas.
 *
 * Data is invented and deterministic: documentation IP ranges (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24), `example.com` hosts, a fixed clock
 * (`_time.ts`). Never paste data from a real hub.
 */

/** An answer, or a function of the call input that returns one. */
export type Fixture = unknown

export interface FixtureArea {
  readonly area: string
  readonly description: string
  readonly handlers: Readonly<Record<string, Fixture>>
}

export interface Resolved {
  readonly found: boolean
  readonly value?: unknown
  readonly error?: string
}

export function defineFixtures(area: FixtureArea): FixtureArea {
  return area
}
