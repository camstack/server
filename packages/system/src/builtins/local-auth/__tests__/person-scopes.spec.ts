/**
 * `setUserScopes` for a person accepts an empty set (admin) or one viewer
 * row. A device, category, capability or addon row is refused — those belong
 * to tokens, and there is no conversion (D900).
 */
import { describe, expect, it } from 'vitest'
import type { UserScope } from '@camstack/types'
import { assertPersonScopes } from '../person-scopes.js'

const VIEWER: UserScope = { type: 'viewer', allow: '*', block: [], features: [] }

describe('assertPersonScopes', () => {
  it('accepts an empty set and exactly one viewer row', () => {
    expect(() => assertPersonScopes([])).not.toThrow()
    expect(() => assertPersonScopes([VIEWER])).not.toThrow()
    expect(() => assertPersonScopes([{ ...VIEWER, allow: [5], block: [9] }])).not.toThrow()
  })

  it('refuses a non-viewer row, a second row, and two viewer rows', () => {
    const rows: readonly (readonly UserScope[])[] = [
      [{ type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] }],
      [{ type: 'category', target: 'device', access: ['view'] }],
      [{ type: 'capability', target: 'user-management', access: ['view'] }],
      [{ type: 'addon', target: 'homeassistant-export', access: ['view'] }],
      [VIEWER, { type: 'category', target: 'device', access: ['view'] }],
      [VIEWER, { ...VIEWER, block: [5] }],
    ]
    for (const scopes of rows) {
      expect(() => assertPersonScopes(scopes)).toThrowError(
        expect.objectContaining({ i18nCode: 'auth.person-scopes-refused' }),
      )
    }
  })
})
