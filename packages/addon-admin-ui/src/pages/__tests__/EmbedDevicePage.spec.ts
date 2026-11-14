import { describe, expect, it, vi } from 'vitest'
import {
  applyEmbedAccessToken,
  embedCardReadyPayload,
  embedHostAction,
  embedHostData,
  embedHostEventTrusted,
} from '../embed-device-host'
import {
  embedCanActuate,
  embedMainClass,
  parseEmbedDeviceId,
  parseEmbedHost,
  parseEmbedLocale,
  parseEmbedTheme,
} from '../EmbedDevicePage'

describe('EmbedDevicePage query parsing', () => {
  it('reads a positive integer device id and refuses anything else', () => {
    expect(parseEmbedDeviceId('1207')).toBe(1207)
    for (const bad of [undefined, '', '0', '-3', '1.5', '12ab', '9'.repeat(30)]) {
      expect(parseEmbedDeviceId(bad)).toBeNull()
    }
  })

  it('accepts only the known themes and locales', () => {
    expect(parseEmbedTheme('dark')).toBe('dark')
    expect(parseEmbedTheme('sepia')).toBeNull()
    expect(parseEmbedLocale('it')).toBe('it')
    expect(parseEmbedLocale('fr')).toBeNull()
    expect(parseEmbedLocale(null)).toBeNull()
  })
})

describe('EmbedDevicePage host and permission', () => {
  it('drops the name only for the viewer host it names', () => {
    expect(parseEmbedHost('viewer')).toBe('viewer')
    expect(parseEmbedHost('admin')).toBeNull()
    expect(parseEmbedHost(null)).toBeNull()
  })

  it("follows the hub's answer for THIS device, not the admin flag", () => {
    expect(embedCanActuate({ view: true, command: true }, false)).toBe(true)
    expect(embedCanActuate({ view: true, command: false }, false)).toBe(false)
    // The hub's per-device answer wins over the admin flag in both directions.
    expect(embedCanActuate({ view: true, command: false }, true)).toBe(false)
  })

  it('without an answer only an admin may act', () => {
    expect(embedCanActuate(null, true)).toBe(true)
    expect(embedCanActuate(null, false)).toBe(false)
  })
})

describe('EmbedDevicePage host messages', () => {
  const search = 'theme=dark&lang=en&host=viewer'

  it('switches device without a reload, keeping the query the host sent', () => {
    const action = embedHostAction(
      true,
      { type: 'show-device', deviceId: 44, theme: 'light', lang: 'it' },
      search,
    )
    expect(action).toEqual({
      kind: 'show',
      path: '/embed/device/44?theme=light&lang=it&host=viewer',
    })
  })

  it('takes a renewed token and ignores anything it cannot trust or parse', () => {
    expect(embedHostAction(true, { type: 'set-token', token: 'next' }, search)).toEqual({
      kind: 'token',
      token: 'next',
    })
    expect(embedHostAction(false, { type: 'set-token', token: 'next' }, search)).toEqual({
      kind: 'ignore',
    })
    expect(embedHostAction(true, { type: 'show-device', deviceId: 0 }, search)).toEqual({
      kind: 'ignore',
    })
    expect(embedHostAction(true, embedHostData('not-json'), search)).toEqual({ kind: 'ignore' })
    expect(embedHostData('{"type":"set-token","token":"n"}')).toEqual({
      type: 'set-token',
      token: 'n',
    })
  })

  it('trusts the native bridge and the same-origin parent, and nobody else', () => {
    const parent = { name: 'parent' }
    const self = { name: 'self' }
    expect(embedHostEventTrusted({ origin: '', source: null }, 'http://hub', parent, self)).toBe(
      true,
    )
    expect(
      embedHostEventTrusted({ origin: 'http://hub', source: parent }, 'http://hub', parent, self),
    ).toBe(true)
    expect(
      embedHostEventTrusted({ origin: 'http://other', source: parent }, 'http://hub', parent, self),
    ).toBe(false)
    expect(
      embedHostEventTrusted(
        { origin: 'http://hub', source: { name: 'child' } },
        'http://hub',
        parent,
        self,
      ),
    ).toBe(false)
  })

  it('posts card-ready with the device id', () => {
    expect(embedCardReadyPayload(44)).toBe('{"type":"card-ready","deviceId":44}')
  })

  it('writes the renewed access token and drops the refresh pair', () => {
    localStorage.setItem('camstack_admin_token', 'old')
    localStorage.setItem('camstack_admin_refresh', 'refresh')
    localStorage.setItem('camstack_admin_token_expires', '1')
    const system = { setToken: vi.fn(), reconnect: vi.fn() }
    applyEmbedAccessToken('fresh', system)
    expect(localStorage.getItem('camstack_admin_token')).toBe('fresh')
    expect(localStorage.getItem('camstack_admin_refresh')).toBeNull()
    expect(localStorage.getItem('camstack_admin_token_expires')).toBeNull()
    expect(system.setToken).toHaveBeenCalledWith('fresh')
    expect(system.reconnect).toHaveBeenCalledOnce()
  })
})

describe('EmbedDevicePage page frame', () => {
  it('paints its own canvas for a browser, none for the viewer sheet', () => {
    expect(embedMainClass('dark', false)).toContain('bg-background')
    const viewer = embedMainClass('dark', true)
    expect(viewer).toContain('bg-transparent')
    expect(viewer).not.toContain('bg-background')
    expect(viewer.startsWith('dark ')).toBe(true)
  })
})
