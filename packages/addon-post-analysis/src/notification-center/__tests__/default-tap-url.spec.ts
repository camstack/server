import { describe, expect, it } from 'vitest'

import { defaultTapUrl } from '../default-tap-url.js'

describe('defaultTapUrl', () => {
  it('a camera notification taps through to the camera AT the event instant', () => {
    // Operator decision (2026-08-18, closing D1 of the click-actions design):
    // the default tap lands on the camera at that timeline — the /camera/[id]
    // route's ?at= recorded seek — not on the live view and not on the event.
    expect(
      defaultTapUrl({
        deviceId: 101,
        timestampMs: 1787067304462,
        tap: { form: 'hub', hubBaseUrl: 'https://hub.example' },
        publicBaseUrl: null,
      }),
    ).toBe('https://hub.example/viewer/camstack/camera/101?at=1787067304462')
  })

  it('tolerates a base with a trailing slash', () => {
    expect(
      defaultTapUrl({
        deviceId: 101,
        timestampMs: 1000,
        tap: { form: 'hub', hubBaseUrl: 'https://hub.example/' },
        publicBaseUrl: null,
      }),
    ).toBe('https://hub.example/viewer/camstack/camera/101?at=1000')
  })

  it('an unknown camera taps through to nothing', () => {
    expect(
      defaultTapUrl({ deviceId: 0, timestampMs: 1000, tap: null, publicBaseUrl: 'https://h' }),
    ).toBeNull()
  })

  it('a SYSTEM event taps into the admin UI, not the viewer', () => {
    // The system branch is delegated (`system-event-tap-url.ts`) — asserted
    // here only to pin that this function stays the single owner of "where a
    // tap lands", so no caller can grow a second one.
    expect(
      defaultTapUrl({
        deviceId: 0,
        timestampMs: 1000,
        tap: null,
        publicBaseUrl: 'https://h',
        systemEvent: { kind: 'addon-update-available', nodeId: 'agent-a' },
      }),
    ).toBe('https://h/system/addons?node=agent-a')
  })

  it('a system event whose kind has no action still taps through to nothing', () => {
    expect(
      defaultTapUrl({
        deviceId: 0,
        timestampMs: 1000,
        tap: null,
        publicBaseUrl: 'https://h',
        systemEvent: { kind: 'detection-blind', deviceId: 101 },
      }),
    ).toBeNull()
  })

  it('no reachable base means no URL — a dead link is worse than none', () => {
    expect(
      defaultTapUrl({ deviceId: 101, timestampMs: 1000, tap: null, publicBaseUrl: null }),
    ).toBeNull()
  })

  it('a camera tap with an unreadable taps role opens the hub viewer on the public endpoint', () => {
    expect(
      defaultTapUrl({ deviceId: 101, timestampMs: 1000, tap: null, publicBaseUrl: 'https://p' }),
    ).toBe('https://p/viewer/camstack/camera/101?at=1000')
  })

  it('a hub address flagged for taps wins over the public endpoint (D734)', () => {
    expect(
      defaultTapUrl({
        deviceId: 101,
        timestampMs: 1000,
        tap: { form: 'hub', hubBaseUrl: 'http://192.0.2.10:4480' },
        publicBaseUrl: 'https://p',
      }),
    ).toBe('http://192.0.2.10:4480/viewer/camstack/camera/101?at=1000')
  })

  describe('the CamStack app link is the taps address (D709)', () => {
    const tap = { form: 'app', hubBaseUrl: 'https://cam.example.top' } as const

    it('a camera tap opens the viewer route on the central domain with hub=', () => {
      expect(
        defaultTapUrl({ deviceId: 101, timestampMs: 1000, tap, publicBaseUrl: 'https://h' }),
      ).toBe('https://camstack.zentik.app/camera/101?at=1000&hub=https%3A%2F%2Fcam.example.top')
    })

    it('is minted even when no public endpoint is known (central page asks once)', () => {
      expect(
        defaultTapUrl({
          deviceId: 101,
          timestampMs: 1000,
          tap: { form: 'app', hubBaseUrl: null },
          publicBaseUrl: null,
        }),
      ).toBe('https://camstack.zentik.app/camera/101?at=1000')
    })

    it('a system event taps into the admin UI on the public endpoint', () => {
      expect(
        defaultTapUrl({
          deviceId: 0,
          timestampMs: 1000,
          tap,
          publicBaseUrl: 'https://h',
          systemEvent: { kind: 'addon-update-available', nodeId: 'agent-a' },
        }),
      ).toBe('https://h/system/addons?node=agent-a')
    })

    it('an unknown camera still gets nothing', () => {
      expect(
        defaultTapUrl({ deviceId: 0, timestampMs: 1000, tap, publicBaseUrl: 'https://h' }),
      ).toBe(null)
    })
  })
})
