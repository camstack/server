import { describe, expect, it } from 'vitest'
import { migrationCatalogueProblems } from '../check-migrations-well-formed.js'

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
