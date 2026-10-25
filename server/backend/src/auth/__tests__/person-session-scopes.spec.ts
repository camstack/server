import { ADMIN_SCOPE, DEFAULT_VIEWER_SCOPE, type CredentialScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { personSessionScopes } from '../person-session-scopes.js'

const ADDON_ROUTES: CredentialScope = { type: 'addon-routes', access: ['view'] }

describe('personSessionScopes', () => {
  it('keeps only the viewer row and the session extras', () => {
    const scopes = personSessionScopes([
      { type: 'device', selector: { kind: 'all' }, access: ['view'], includeLinked: true },
      DEFAULT_VIEWER_SCOPE,
      ADDON_ROUTES,
    ])
    expect(scopes).toEqual([DEFAULT_VIEWER_SCOPE, ADDON_ROUTES])
  })

  it('never lets a stored wildcard through for a non-admin person', () => {
    expect(personSessionScopes([ADMIN_SCOPE, ADDON_ROUTES])).toEqual([ADDON_ROUTES])
    expect(personSessionScopes([ADMIN_SCOPE, DEFAULT_VIEWER_SCOPE])).toEqual([DEFAULT_VIEWER_SCOPE])
  })
})
