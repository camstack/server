/**
 * The System page (`/system/settings`) hosts Settings, Secrets, Capabilities
 * as `?tab=` tabs (Terminal stays standalone). The pages that used to stand alone redirect
 * to their tab, carrying their own query (`/system/secrets?view=audit` keeps
 * `view=audit`).
 */
import { describe, expect, it } from 'vitest'
import {
  SYSTEM_LEGACY_ROUTES,
  SYSTEM_PAGE_PATH,
  SYSTEM_TABS,
  systemTabHref,
} from '../system-page-url'

describe('systemTabHref', () => {
  it('names the tab on the System page', () => {
    expect(systemTabHref('secrets')).toBe(`${SYSTEM_PAGE_PATH}?tab=secrets`)
  })

  it('keeps the query a legacy link carried', () => {
    expect(systemTabHref('secrets', '?view=audit')).toBe(
      `${SYSTEM_PAGE_PATH}?view=audit&tab=secrets`,
    )
  })

  it('a stale ?tab= in the carried query never wins over the target tab', () => {
    expect(systemTabHref('capabilities', '?tab=bogus')).toBe(`${SYSTEM_PAGE_PATH}?tab=capabilities`)
  })
})

describe('SYSTEM_LEGACY_ROUTES', () => {
  it('every former standalone page redirects to its tab', () => {
    expect(Object.fromEntries(SYSTEM_LEGACY_ROUTES.map((r) => [r.path, r.tab]))).toEqual({
      '/system/secrets': 'secrets',
      '/system/capabilities': 'capabilities',
    })
  })

  it('every redirect lands on a tab the page declares', () => {
    for (const r of SYSTEM_LEGACY_ROUTES) expect(SYSTEM_TABS).toContain(r.tab)
  })

  it('the System page itself stays at the path every old link and the sidebar use', () => {
    expect(SYSTEM_PAGE_PATH).toBe('/system/settings')
  })
})
