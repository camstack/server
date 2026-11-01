/**
 * The System page (`/system/settings`) hosts Settings and Capabilities
 * as `?tab=` tabs (Terminal stays standalone). The pages that used to stand alone redirect
 * to their tab, carrying their own query. Secrets moved to Data, and its sub-view
 * param is `secretsView` because Records owns `view`.
 */
import { describe, expect, it } from 'vitest'
import {
  SECRETS_LEGACY_PATH,
  SYSTEM_LEGACY_ROUTES,
  SYSTEM_PAGE_PATH,
  SYSTEM_TABS,
  secretsTabHref,
  systemTabHref,
} from '../system-page-url'

describe('systemTabHref', () => {
  it('names the tab on the System page', () => {
    expect(systemTabHref('capabilities')).toBe(`${SYSTEM_PAGE_PATH}?tab=capabilities`)
  })

  it('keeps the query a legacy link carried', () => {
    expect(systemTabHref('capabilities', '?node=hub')).toBe(
      `${SYSTEM_PAGE_PATH}?node=hub&tab=capabilities`,
    )
  })

  it('a stale ?tab= in the carried query never wins over the target tab', () => {
    expect(systemTabHref('capabilities', '?tab=bogus')).toBe(`${SYSTEM_PAGE_PATH}?tab=capabilities`)
  })
})

describe('SYSTEM_LEGACY_ROUTES', () => {
  it('every former standalone page redirects to its tab', () => {
    expect(Object.fromEntries(SYSTEM_LEGACY_ROUTES.map((r) => [r.path, r.tab]))).toEqual({
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

describe('secretsTabHref', () => {
  it('lands on the Secrets tab of Data', () => {
    expect(secretsTabHref()).toBe('/system/data?tab=secrets')
    expect(SECRETS_LEGACY_PATH).toBe('/system/secrets')
  })

  it('renames the old ?view=audit so it no longer collides with Records', () => {
    expect(secretsTabHref('?view=audit&tab=secrets')).toBe(
      '/system/data?tab=secrets&secretsView=audit',
    )
  })

  it('drops the default view and any other Records-owned value', () => {
    expect(secretsTabHref('?view=values')).toBe('/system/data?tab=secrets')
    expect(secretsTabHref('?view=deleted-devices')).toBe('/system/data?tab=secrets')
  })
})
