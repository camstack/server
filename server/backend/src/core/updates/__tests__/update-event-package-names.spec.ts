/**
 * The notification package picker (`@camstack/types`) offers exactly the
 * package names update EVENTS carry. Types cannot import the producers, so
 * this spec pins each picker literal to the constant its producer stamps.
 */
import { HUB_ROOT_SPEC } from '@camstack/node-root'
import { NC_SERVER_PACKAGE_NAME, NC_UPDATE_EVENT_PACKAGE_NAMES } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { WRAPPER_PACKAGE_NAME } from '../wrapper-update-checker.js'

describe('NC_UPDATE_EVENT_PACKAGE_NAMES — one entry per update-event producer', () => {
  it('server-update*: the hub root package', () => {
    expect(NC_SERVER_PACKAGE_NAME).toBe(HUB_ROOT_SPEC.packageName)
  })

  it('is exactly [root package, wrapper literal]', () => {
    // The framework ships inside the root package (D988): `listFrameworkPackages`
    // has no row of its own, and `@camstack/types` / `@camstack/sdk` are never
    // announced, so none of them is offered.
    expect(NC_UPDATE_EVENT_PACKAGE_NAMES).toEqual([HUB_ROOT_SPEC.packageName, WRAPPER_PACKAGE_NAME])
  })
})
