import type { HubAddressBook, HubAddressRow } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { roleToggle, summarizeRoles } from '../address-table-model'

function row(over: Partial<HubAddressRow> & Pick<HubAddressRow, 'baseUrl'>): HubAddressRow {
  const base: HubAddressRow = {
    label: 'LAN — eth0',
    baseUrl: over.baseUrl,
    kind: 'lan-ipv4',
    interfaceKind: 'lan',
    plausible: true,
    plausibleReason: '',
    priority: 0,
    detected: true,
    custom: false,
    flags: [],
    inUse: [],
    eligible: ['appConnections', 'notificationTaps', 'internal', 'publicEndpoint'],
  }
  return { ...base, ...over }
}

describe('roleToggle — detected and custom rows behave the same', () => {
  it.each([
    row({ baseUrl: 'https://192.0.2.10:4443' }),
    row({ baseUrl: 'https://cams.example.org', kind: 'custom', detected: false, custom: true }),
  ])('ticking Internal on $kind flags it', (r) => {
    expect(roleToggle(r, 'internal')).toEqual({
      kind: 'set',
      input: { role: 'internal', baseUrl: r.baseUrl, enabled: true },
    })
  })

  it('unticking a flagged single role returns the flag (automatic)', () => {
    const r = row({ baseUrl: 'https://192.0.2.10:4443', flags: ['internal'], inUse: ['internal'] })
    expect(roleToggle(r, 'internal')).toEqual({
      kind: 'set',
      input: { role: 'internal', baseUrl: r.baseUrl, enabled: false },
    })
  })

  it('a row serving a single role automatically is pinned when clicked', () => {
    const r = row({ baseUrl: 'https://192.0.2.10:4443', inUse: ['internal'] })
    expect(roleToggle(r, 'internal')).toEqual({
      kind: 'set',
      input: { role: 'internal', baseUrl: r.baseUrl, enabled: true },
    })
  })

  it('an automatic app-connections row unticked leaves the race', () => {
    const r = row({ baseUrl: 'https://192.0.2.10:4443', inUse: ['appConnections'] })
    expect(roleToggle(r, 'appConnections')).toEqual({
      kind: 'set',
      input: { role: 'appConnections', baseUrl: r.baseUrl, enabled: false },
    })
  })

  it('plain-http sign-in asks the operator to accept http first', () => {
    const r = row({ baseUrl: 'http://192.0.2.10:4480' })
    const toggle = roleToggle(r, 'publicEndpoint')
    expect(toggle.kind).toBe('confirm-http')
    // Other roles take http without ceremony.
    expect(roleToggle(r, 'internal').kind).toBe('set')
  })

  it('the app link returns notification taps to automatic, and nothing else', () => {
    const app = row({
      baseUrl: 'https://camstack.zentik.app',
      kind: 'app-link',
      detected: false,
      eligible: ['notificationTaps'],
    })
    expect(roleToggle(app, 'notificationTaps')).toEqual({
      kind: 'set',
      input: { role: 'notificationTaps', baseUrl: null, enabled: true },
    })
    expect(roleToggle(app, 'appConnections')).toEqual({ kind: 'none' })
    expect(roleToggle({ ...app, inUse: ['notificationTaps'] }, 'notificationTaps')).toEqual({
      kind: 'none',
    })
  })

  it('loopback is never flaggable', () => {
    const lo = row({ baseUrl: 'https://127.0.0.1:4443', kind: 'loopback', eligible: [] })
    expect(roleToggle(lo, 'internal')).toEqual({ kind: 'none' })
  })
})

describe('summarizeRoles', () => {
  it('says per role what is in use and whether it is automatic', () => {
    const book: HubAddressBook = {
      rows: [],
      roles: {
        appConnections: { flagged: [], resolved: ['http://192.0.2.10:4480'], source: 'auto' },
        notificationTaps: {
          flagged: null,
          resolved: 'https://camstack.zentik.app',
          source: 'auto',
        },
        internal: {
          flagged: 'https://10.8.0.1:4443',
          resolved: 'https://10.8.0.1:4443',
          source: 'flagged',
        },
        publicEndpoint: { flagged: null, resolved: null, source: 'none' },
      },
      appLinkHub: null,
    }
    expect(summarizeRoles(book)).toEqual([
      {
        role: 'appConnections',
        title: 'App connections',
        inUse: 'http://192.0.2.10:4480',
        automatic: true,
      },
      {
        role: 'notificationTaps',
        title: 'Notification taps',
        inUse: 'CamStack app link',
        automatic: true,
      },
      {
        role: 'publicEndpoint',
        title: 'Public endpoint',
        inUse: 'nothing reachable',
        automatic: true,
      },
      { role: 'internal', title: 'Internal', inUse: 'https://10.8.0.1:4443', automatic: false },
    ])
  })
})
