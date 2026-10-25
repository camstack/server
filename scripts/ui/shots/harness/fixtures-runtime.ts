/**
 * Picks the fixture areas for this page load and answers tRPC paths from them.
 *
 * Every `scripts/ui/shots/fixtures/<area>.ts` (not `_*.ts`) is an area. The
 * `fx` switch (`?fx=access,backup`, default `all`) selects areas; they are
 * consulted in the order given, then `shell` (always on) — so an area can
 * override a shell answer.
 */
import type { FixtureArea, Resolved } from '../fixtures/_define'

const modules = import.meta.glob<{ default: FixtureArea }>(
  ['../fixtures/*.ts', '!../fixtures/_*.ts'],
  {
    eager: true,
  },
)

const AREAS = new Map<string, FixtureArea>(
  Object.values(modules).map((m) => [m.default.area, m.default]),
)

function selectedAreas(): FixtureArea[] {
  const fx = sessionStorage.getItem('ui-shots:fx') ?? 'all'
  const names =
    fx === 'all'
      ? [...AREAS.keys()].filter((n) => n !== 'shell').toSorted()
      : fx
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '' && s !== 'shell')
  const unknown = names.filter((n) => !AREAS.has(n))
  if (unknown.length > 0) {
    throw new Error(
      `ui:shots: unknown fixture area(s) ${unknown.join(', ')} — have ${[...AREAS.keys()].join(', ')}`,
    )
  }
  const shell = AREAS.get('shell')
  return [...names.map((n) => AREAS.get(n) as FixtureArea), ...(shell ? [shell] : [])]
}

const LAYERS = selectedAreas()

export function resolveFixture(path: string, input: unknown, mutation: boolean): Resolved {
  const key = mutation ? `mut:${path}` : path
  for (const area of LAYERS) {
    if (!(key in area.handlers)) continue
    const v = area.handlers[key]
    const value = typeof v === 'function' ? (v as (i: unknown) => unknown)(input) : v
    if (value !== null && typeof value === 'object' && '__error' in value) {
      return { found: true, error: String((value as { __error: unknown }).__error) }
    }
    return { found: true, value }
  }
  return { found: false, value: mutation ? { ok: true } : null }
}
