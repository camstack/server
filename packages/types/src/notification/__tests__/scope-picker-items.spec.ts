import { describe, expect, it } from 'vitest'
import {
  NC_SERVER_PACKAGE_NAME,
  NC_UPDATE_EVENT_PACKAGE_NAMES,
  nodePickerItems,
  packagePickerItems,
} from '../scope-picker-items.js'

describe('scope picker items', () => {
  it('groups nodes by role and liveness; the id is the second line when it differs from the name', () => {
    expect(
      nodePickerItems([
        { id: 'hub', name: 'hub', isHub: true, isOnline: true },
        { id: 'agent-a', name: 'Mac mini', isHub: false, isOnline: false },
      ]),
    ).toEqual([
      { id: 'hub', name: 'hub', type: 'hub', location: 'online' },
      { id: 'agent-a', name: 'Mac mini', type: 'agent', location: 'offline', detail: 'agent-a' },
    ])
  })

  it('lists installed packages sorted, always offers the server package once, version as detail', () => {
    const items = packagePickerItems([
      { name: '@camstack/addon-recorder', version: '1.2.0' },
      { name: '@camstack/addon-pipeline', version: '1.0.0' },
    ])
    expect(items.map((i) => i.id)).toEqual([
      NC_SERVER_PACKAGE_NAME,
      ...NC_UPDATE_EVENT_PACKAGE_NAMES.filter((name) => name !== NC_SERVER_PACKAGE_NAME),
      '@camstack/addon-pipeline',
      '@camstack/addon-recorder',
    ])
    expect(items[NC_UPDATE_EVENT_PACKAGE_NAMES.length]).toEqual({
      id: '@camstack/addon-pipeline',
      name: '@camstack/addon-pipeline',
      type: 'addon',
      location: null,
      detail: '1.0.0',
    })
    expect(
      packagePickerItems([{ name: NC_SERVER_PACKAGE_NAME, version: '9' }]).filter(
        (i) => i.id === NC_SERVER_PACKAGE_NAME,
      ),
    ).toHaveLength(1)
  })

  it('offers every package an update EVENT carries, even when listPackages omits it', () => {
    expect(packagePickerItems([])).toEqual([
      { id: '@camstack/server', name: '@camstack/server', type: 'server', location: null },
      { id: '@camstack/system', name: '@camstack/system', type: 'framework', location: null },
      { id: 'camstack-wrapper', name: 'camstack-wrapper', type: 'wrapper', location: null },
    ])
  })

  it('offers no framework package no update event carries', () => {
    const ids = packagePickerItems([]).map((i) => i.id)
    expect(ids).not.toContain('@camstack/types')
    expect(ids).not.toContain('@camstack/sdk')
  })

  it('an installed update-event package is offered once, with its version', () => {
    const items = packagePickerItems([{ name: '@camstack/system', version: '2.0.0' }])
    expect(items.filter((i) => i.id === '@camstack/system')).toEqual([
      {
        id: '@camstack/system',
        name: '@camstack/system',
        type: 'framework',
        location: null,
        detail: '2.0.0',
      },
    ])
  })

  // The producers live in the backend / node-root, which types cannot import:
  // `server/backend/src/core/updates/__tests__/update-event-package-names.spec.ts`
  // pins each literal below to its producer constant.
  it('the literals are the ones the update producers stamp', () => {
    expect(NC_SERVER_PACKAGE_NAME).toBe('@camstack/server')
    expect(NC_UPDATE_EVENT_PACKAGE_NAMES).toEqual([
      '@camstack/server',
      '@camstack/system',
      'camstack-wrapper',
    ])
  })
})
