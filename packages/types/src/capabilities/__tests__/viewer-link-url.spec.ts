import { describe, expect, it } from 'vitest'
import type { ConnectionEndpoint } from '../local-network.cap.js'
import {
  buildViewerLink,
  CAMSTACK_APP_LINK_ORIGIN,
  isAppLinkBase,
  pickAppLinkHub,
  toAppLinkHubOrigin,
} from '../viewer-link-url.js'

function ep(over: Partial<ConnectionEndpoint> & Pick<ConnectionEndpoint, 'baseUrl'>) {
  const base: ConnectionEndpoint = {
    label: 'LAN — eth0',
    baseUrl: over.baseUrl,
    kind: 'lan-ipv4',
    interfaceKind: 'lan',
    plausible: true,
    plausibleReason: '',
    priority: 0,
  }
  return { ...base, ...over }
}

const camera = { kind: 'camera', deviceId: 101, atMs: 1787067304462 } as const

describe('buildViewerLink — hub form', () => {
  it('is the pre-D709 tap byte for byte', () => {
    expect(
      buildViewerLink({
        base: { form: 'hub', hubBaseUrl: 'https://hub.example/' },
        destination: camera,
      }),
    ).toBe('https://hub.example/viewer/camstack/camera/101?at=1787067304462')
  })
  it('no base means no link', () => {
    expect(buildViewerLink({ base: { form: 'hub', hubBaseUrl: null }, destination: camera })).toBe(
      null,
    )
  })
  it('never mounts the viewer under the app-link domain', () => {
    expect(
      buildViewerLink({
        base: { form: 'hub', hubBaseUrl: CAMSTACK_APP_LINK_ORIGIN },
        destination: camera,
      }),
    ).toBeNull()
  })
})

describe('buildViewerLink — app form', () => {
  it('opens the viewer route on the central domain and carries the hub origin', () => {
    expect(
      buildViewerLink({
        base: { form: 'app', hubBaseUrl: 'https://cam.example.top/viewer/camstack/' },
        destination: camera,
      }),
    ).toBe(
      'https://camstack.zentik.app/camera/101?at=1787067304462&hub=https%3A%2F%2Fcam.example.top',
    )
  })
  it('is minted without hub= when no hub address is known (central page asks once)', () => {
    expect(buildViewerLink({ base: { form: 'app', hubBaseUrl: null }, destination: camera })).toBe(
      'https://camstack.zentik.app/camera/101?at=1787067304462',
    )
  })
  it('events and notifications use the AASA-claimed paths', () => {
    const base = { form: 'app', hubBaseUrl: 'https://h.example:4443' } as const
    expect(buildViewerLink({ base, destination: { kind: 'events' } })).toBe(
      'https://camstack.zentik.app/events?hub=https%3A%2F%2Fh.example%3A4443',
    )
    expect(buildViewerLink({ base, destination: { kind: 'notifications' } })).toBe(
      'https://camstack.zentik.app/notifications?hub=https%3A%2F%2Fh.example%3A4443',
    )
  })
  it('an unknown camera gets no link in either form', () => {
    const destination = { kind: 'camera', deviceId: 0 } as const
    expect(buildViewerLink({ base: { form: 'app', hubBaseUrl: null }, destination })).toBeNull()
    expect(buildViewerLink({ base: { form: 'hub', hubBaseUrl: 'https://h' }, destination })).toBe(
      null,
    )
  })
})

describe('pickAppLinkHub', () => {
  const lan = ep({ baseUrl: 'http://192.168.10.9:4080', priority: 0 })
  const tunnel = ep({
    baseUrl: 'https://cam.example.top',
    kind: 'public',
    interfaceKind: 'public',
    priority: 100,
  })
  const mesh = ep({
    baseUrl: 'https://hub.tail1234.ts.net:4443',
    kind: 'public',
    interfaceKind: 'vpn',
    priority: 150,
  })
  it('the tunnel beats the mesh, and the LAN never qualifies', () => {
    expect(pickAppLinkHub([lan, mesh, tunnel])).toBe('https://cam.example.top')
    expect(pickAppLinkHub([lan, mesh])).toBe('https://hub.tail1234.ts.net:4443')
    expect(pickAppLinkHub([lan])).toBeNull()
  })
  it('ignores the app-link entry itself and plain-http public entries', () => {
    expect(
      pickAppLinkHub([
        ep({ baseUrl: CAMSTACK_APP_LINK_ORIGIN, kind: 'app-link', interfaceKind: 'public' }),
        ep({ baseUrl: 'http://cam.example.top', kind: 'public', interfaceKind: 'public' }),
      ]),
    ).toBeNull()
  })
})

describe('isAppLinkBase / toAppLinkHubOrigin', () => {
  it('recognises the central origin with or without a trailing path', () => {
    expect(isAppLinkBase('https://camstack.zentik.app')).toBe(true)
    expect(isAppLinkBase('https://camstack.zentik.app/')).toBe(true)
    expect(isAppLinkBase('https://cam.example.top')).toBe(false)
    expect(isAppLinkBase(null)).toBe(false)
    expect(isAppLinkBase('not a url')).toBe(false)
  })
  it('refuses credentials and non-http schemes', () => {
    expect(toAppLinkHubOrigin('https://u:p@h.example')).toBeNull()
    expect(toAppLinkHubOrigin('ftp://h.example')).toBeNull()
    expect(toAppLinkHubOrigin('https://h.example:4443/x?y')).toBe('https://h.example:4443')
  })
})
