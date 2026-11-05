import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOME_CONNECT_LOGIN_HOSTS } from '../../home-connect/home-connect-sign-in-proxy.js'
import { HOMECOM_LOGIN_HOSTS } from '../../homecom/homecom-sign-in-proxy.js'

/** Hosts the SingleKey ID login page pulls its scripts and styles from (public page, captured 2026-11). */
const page = readFileSync(
  new URL(
    '../../../../types/src/vendor-login-proxy/__tests__/fixtures/singlekey-login.html',
    import.meta.url,
  ),
  'utf8',
)
const assetHosts = [
  ...new Set(
    [...page.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="https:\/\/([^/"]+)/gi)].map(
      (m) => m[1],
    ),
  ),
].filter((h): h is string => h !== undefined && h !== 'singlekey-id.com')

describe('vendor login hosts', () => {
  it('the fixture really names a script host', () => {
    expect(assetHosts).toContain('cdn.singlekey-id.com')
  })
  it.each([
    ['HomeCom', HOMECOM_LOGIN_HOSTS],
    ['Home Connect', HOME_CONNECT_LOGIN_HOSTS],
  ])('%s proxies every host its login page loads scripts from', (_name, hosts) => {
    for (const host of assetHosts) expect(hosts).toContain(host)
    expect(hosts).toContain('singlekey-id.com')
  })
})
