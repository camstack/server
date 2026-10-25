/**
 * The notification body printed zone UUIDs instead of zone names.
 *
 * Live example (2026-07-30 18:54 UTC, "Persona su Uscio" on device 101):
 *
 *   title: "Persona su Uscio"
 *   body:  "person on Camera front door in
 *           cfeec78c-8d69-4678-9d25-937193eacb5d, fa03b60a-5669-4a8a-976b-bac422f5f530"
 *
 * The title looked right only because it is the operator's own rule NAME. The
 * body joins `subject.zones`, which carries admin zone IDs — the same ids the
 * rule's `zones.ids` condition matches on. Two of them appear because the track
 * had visited both `Uscio` and `Aiuola`.
 *
 * Conditions must keep matching on ids (names are not stable identifiers);
 * only the RENDERED text resolves to names. An unresolvable id falls back to
 * the id rather than vanishing — a body that silently drops a zone is worse
 * than an ugly one.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveZoneLabels } from '../dispatcher.js'

describe('resolveZoneLabels', () => {
  it('renders names instead of the raw ids', async () => {
    const getZoneNames = vi.fn(async () => [
      { id: 'cfeec78c-8d69-4678-9d25-937193eacb5d', name: 'Uscio' },
      { id: 'fa03b60a-5669-4a8a-976b-bac422f5f530', name: 'Aiuola' },
    ])

    await expect(
      resolveZoneLabels(getZoneNames, 101, [
        'cfeec78c-8d69-4678-9d25-937193eacb5d',
        'fa03b60a-5669-4a8a-976b-bac422f5f530',
      ]),
    ).resolves.toEqual(['Uscio', 'Aiuola'])
  })

  it('preserves the order the track visited them in, not the catalog order', async () => {
    const getZoneNames = vi.fn(async () => [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ])
    await expect(resolveZoneLabels(getZoneNames, 1, ['b', 'a'])).resolves.toEqual(['Beta', 'Alpha'])
  })

  it('falls back to the id when a zone is unknown — never drops it', async () => {
    const getZoneNames = vi.fn(async () => [{ id: 'a', name: 'Alpha' }])
    await expect(resolveZoneLabels(getZoneNames, 1, ['a', 'gone'])).resolves.toEqual([
      'Alpha',
      'gone',
    ])
  })

  it('falls back to ids wholesale when the lookup throws', async () => {
    const getZoneNames = vi.fn(async () => {
      throw new Error('zones cap unavailable')
    })
    await expect(resolveZoneLabels(getZoneNames, 1, ['a', 'b'])).resolves.toEqual(['a', 'b'])
  })

  it('returns ids unchanged when no resolver is wired at all', async () => {
    await expect(resolveZoneLabels(undefined, 1, ['a', 'b'])).resolves.toEqual(['a', 'b'])
  })

  it('does not call the lookup for an empty zone list', async () => {
    const getZoneNames = vi.fn(async () => [])
    await expect(resolveZoneLabels(getZoneNames, 1, [])).resolves.toEqual([])
    expect(getZoneNames).not.toHaveBeenCalled()
  })

  it('ignores a blank name rather than rendering an empty slot', async () => {
    const getZoneNames = vi.fn(async () => [{ id: 'a', name: '   ' }])
    await expect(resolveZoneLabels(getZoneNames, 1, ['a'])).resolves.toEqual(['a'])
  })
})
