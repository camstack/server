import { describe, expect, it } from 'vitest'
import {
  migrationCatalogueProblems,
  migrationShapeProblems,
  type CatalogueShape,
} from '../check-migrations-well-formed.js'

function meta(id: string, seq: number, dependsOn: string[] = []): object {
  return {
    id,
    owner: 'hub',
    level: 'hub-store',
    seq,
    dependsOn,
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'sql',
    description: 'd',
    fixtureMark: 'm',
  }
}

describe('check-migrations-well-formed', () => {
  it('accepts an empty and a well formed catalogue', () => {
    expect(migrationCatalogueProblems([])).toEqual([])
    expect(
      migrationCatalogueProblems([meta('hub/2026-10-31-a', 1), meta('hub/2026-10-31-b', 2)]),
    ).toEqual([])
  })

  it('refuses a duplicate id, a backwards seq, an unknown dependency and a cycle', () => {
    expect(
      migrationCatalogueProblems([meta('hub/2026-10-31-a', 1), meta('hub/2026-10-31-a', 2)]).join(),
    ).toMatch(/duplicate/)
    expect(
      migrationCatalogueProblems([meta('hub/2026-10-31-a', 2), meta('hub/2026-10-31-b', 1)]).join(),
    ).toMatch(/seq/)
    expect(
      migrationCatalogueProblems([meta('hub/2026-10-31-a', 1, ['hub/2026-10-31-zzz'])]).join(),
    ).toMatch(/unknown|known|depends/)
    expect(
      migrationCatalogueProblems([
        meta('hub/2026-10-31-a', 1, ['hub/2026-10-31-b']),
        meta('hub/2026-10-31-b', 2, ['hub/2026-10-31-a']),
      ]).join(),
    ).toMatch(/cycle/)
  })
})

function addon(entries: CatalogueShape['entries'], runs = true): CatalogueShape {
  return { name: 'addon-x', kind: 'addon', addonIds: ['x'], entries, runsItsCatalogue: runs }
}

const addonMeta = (kind: string, extra: object = {}): object => ({
  id: 'x/2026-11-01-a',
  owner: 'x',
  level: 'addon',
  bodyKind: kind,
  ...extra,
})

describe('migrationShapeProblems', () => {
  it('accepts an addon plan and procedure with the matching body and a runMigrations call', () => {
    expect(
      migrationShapeProblems(
        addon([
          { meta: addonMeta('plan'), bodies: ['plan'] },
          { meta: addonMeta('procedure'), bodies: ['procedure'] },
        ]),
      ),
    ).toEqual([])
  })

  it('refuses a body that does not match its kind, an sql addon body and a foreign owner', () => {
    expect(
      migrationShapeProblems(addon([{ meta: addonMeta('plan'), bodies: ['procedure'] }])).join(),
    ).toMatch(/needs exactly a "plan"/)
    expect(
      migrationShapeProblems(addon([{ meta: addonMeta('sql'), bodies: ['run'] }])).join(),
    ).toMatch(/hub-only/)
    expect(
      migrationShapeProblems(
        addon([{ meta: addonMeta('plan', { owner: 'y' }), bodies: ['plan'] }]),
      ).join(),
    ).toMatch(/not an addon id/)
  })

  it('refuses an addon with a catalogue that never runs it, and a hub procedure', () => {
    expect(
      migrationShapeProblems(addon([{ meta: addonMeta('plan'), bodies: ['plan'] }], false)).join(),
    ).toMatch(/runMigrations/)
    const hub: CatalogueShape = {
      name: 'hub',
      kind: 'hub',
      addonIds: [],
      runsItsCatalogue: true,
      entries: [
        {
          meta: addonMeta('procedure', { owner: 'hub', level: 'hub-store' }),
          bodies: ['procedure'],
        },
      ],
    }
    expect(migrationShapeProblems(hub).join()).toMatch(/no procedure body/)
  })
})
