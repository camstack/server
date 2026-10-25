/**
 * `buildDeviceAdminUrl` / `parseAdminBase` — the credential gate on the one
 * string this capability exists to produce.
 *
 * The cases that matter are not the happy ones. They are the ones where a
 * provider hands the builder something that came out of a device config next to
 * a password, or an operator types a whole URL with his login in it.
 *
 * The wire-truth cases (`:9000` is not a web port) are pinned here as shapes;
 * they were verified against the live fleet on 2026-09-22 and the numbers are
 * in the private session log.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDeviceAdminUrl,
  parseAdminBase,
  type DeviceAdminBase,
} from '../device-admin-link-url.js'

function urlOf(result: ReturnType<typeof buildDeviceAdminUrl>): string {
  if (!result.ok) throw new Error(`expected a url, got refusal "${result.reason}"`)
  return result.url
}

function baseOf(result: ReturnType<typeof parseAdminBase>): DeviceAdminBase {
  if (!result.ok) throw new Error(`expected a base, got refusal "${result.reason}"`)
  return result
}

describe('buildDeviceAdminUrl — the shape it emits', () => {
  it('omits the port when it is the scheme default (Hikvision 1436: host 192.168.60.139, port 80, https false)', () => {
    const built = buildDeviceAdminUrl({
      host: '192.168.60.139',
      port: 80,
      scheme: 'http',
      path: '/',
    })
    expect(urlOf(built)).toBe('http://192.168.60.139/')
  })

  it('omits 443 under https and keeps a non-default port', () => {
    expect(
      urlOf(buildDeviceAdminUrl({ host: 'nas.lan', port: 443, scheme: 'https', path: '/' })),
    ).toBe('https://nas.lan/')
    expect(
      urlOf(buildDeviceAdminUrl({ host: 'nas.lan', port: 8443, scheme: 'https', path: '/' })),
    ).toBe('https://nas.lan:8443/')
  })

  it('a null port means "the scheme default" and never prints', () => {
    expect(
      urlOf(buildDeviceAdminUrl({ host: '192.168.60.226', port: null, scheme: 'http', path: '/' })),
    ).toBe('http://192.168.60.226/')
  })

  it('brackets an IPv6 literal through unchanged', () => {
    expect(
      urlOf(buildDeviceAdminUrl({ host: '[fd00::1]', port: 8123, scheme: 'http', path: '/' })),
    ).toBe('http://[fd00::1]:8123/')
  })

  it('encodes query values and keeps the path (the Home Assistant entity page)', () => {
    const built = buildDeviceAdminUrl({
      host: 'ha.lan',
      port: 8123,
      scheme: 'http',
      path: '/history',
      query: { entity_id: 'binary_sensor.doorbell status' },
    })
    expect(urlOf(built)).toBe('http://ha.lan:8123/history?entity_id=binary_sensor.doorbell+status')
  })
})

describe('buildDeviceAdminUrl — the credential gate', () => {
  it('refuses a host that smuggles userinfo, which is how a password reaches the authority', () => {
    // Exactly the accident the builder exists to prevent: a provider that
    // builds `${username}:${password}@${host}` and passes the result as `host`.
    const built = buildDeviceAdminUrl({
      host: 'admin:hunter2@192.168.60.139',
      port: 80,
      scheme: 'http',
      path: '/',
    })
    expect(built).toEqual({ ok: false, reason: 'host-carries-userinfo' })
  })

  it.each([
    'password',
    'Password',
    'pwd',
    'user',
    'username',
    'token',
    'access_token',
    'apikey',
    'auth',
    'secret',
    'session',
  ])('refuses the credential-shaped query key %s', (key) => {
    const built = buildDeviceAdminUrl({
      host: 'cam.lan',
      port: null,
      scheme: 'http',
      path: '/',
      query: { [key]: 'hunter2' },
    })
    expect(built).toEqual({ ok: false, reason: 'credential-query-key' })
  })

  it('no accepted input can produce a userinfo URL', () => {
    // The authority is assembled from a host that matched PLAIN_HOST or the
    // IPv6 form, so `@` cannot appear in it; the re-check is the backstop.
    for (const host of ['cam.lan', '192.168.10.9', '[fd00::1]', 'a-b_c.d']) {
      const built = buildDeviceAdminUrl({ host, port: null, scheme: 'https', path: '/' })
      expect(urlOf(built)).not.toMatch(/:\/\/[^/]*@/)
    }
  })

  it('refuses a host carrying a scheme, a path or whitespace rather than pasting it into the authority', () => {
    expect(
      buildDeviceAdminUrl({ host: 'http://cam.lan', port: null, scheme: 'http', path: '/' }),
    ).toEqual({
      ok: false,
      reason: 'host-not-plain',
    })
    expect(
      buildDeviceAdminUrl({ host: 'cam.lan/evil', port: null, scheme: 'http', path: '/' }),
    ).toEqual({
      ok: false,
      reason: 'host-not-plain',
    })
    expect(buildDeviceAdminUrl({ host: 'cam lan', port: null, scheme: 'http', path: '/' })).toEqual(
      {
        ok: false,
        reason: 'host-not-plain',
      },
    )
  })

  it('refuses an empty host, an out-of-range port and a relative path, each by name', () => {
    expect(buildDeviceAdminUrl({ host: '   ', port: null, scheme: 'http', path: '/' })).toEqual({
      ok: false,
      reason: 'empty-host',
    })
    expect(buildDeviceAdminUrl({ host: 'cam.lan', port: 0, scheme: 'http', path: '/' })).toEqual({
      ok: false,
      reason: 'port-out-of-range',
    })
    expect(
      buildDeviceAdminUrl({ host: 'cam.lan', port: 70000, scheme: 'http', path: '/' }),
    ).toEqual({
      ok: false,
      reason: 'port-out-of-range',
    })
    expect(
      buildDeviceAdminUrl({ host: 'cam.lan', port: null, scheme: 'http', path: 'config' }),
    ).toEqual({
      ok: false,
      reason: 'path-not-absolute',
    })
  })

  it('refuses rather than throws — a device with a bad host must not fail the whole surface', () => {
    expect(() =>
      buildDeviceAdminUrl({ host: 'admin:p@h', port: null, scheme: 'http', path: '/' }),
    ).not.toThrow()
  })
})

describe('parseAdminBase — the one input that arrives as a whole URL', () => {
  it('splits an operator-configured Home Assistant base URL', () => {
    const base = baseOf(parseAdminBase('http://192.168.10.89:8123'))
    expect(base).toMatchObject({ host: '192.168.10.89', port: 8123, scheme: 'http', basePath: '' })
  })

  it('keeps a path prefix and drops the trailing slash', () => {
    expect(baseOf(parseAdminBase('https://ha.example.org/ha/')).basePath).toBe('/ha')
    expect(baseOf(parseAdminBase('https://ha.example.org/')).basePath).toBe('')
  })

  it('reports a null port when the base URL left it to the scheme', () => {
    expect(baseOf(parseAdminBase('https://ha.example.org')).port).toBeNull()
  })

  it('REFUSES a base URL with userinfo instead of quietly stripping it', () => {
    // Quietly stripping would work and would be wrong: the operator believes
    // those credentials are in use, and the addon's HTTP client may well be
    // using them. A refusal makes the button disappear, which is visible.
    expect(parseAdminBase('https://admin:hunter2@ha.lan:8123/')).toEqual({
      ok: false,
      reason: 'base-carries-userinfo',
    })
    expect(parseAdminBase('https://admin@ha.lan:8123/')).toEqual({
      ok: false,
      reason: 'base-carries-userinfo',
    })
  })

  it('refuses a non-http scheme and unparseable text', () => {
    expect(parseAdminBase('ws://ha.lan:8123')).toEqual({ ok: false, reason: 'scheme-not-http' })
    expect(parseAdminBase('ha.lan:8123')).toEqual({ ok: false, reason: 'scheme-not-http' })
    expect(parseAdminBase('not a url')).toEqual({ ok: false, reason: 'unparseable' })
    expect(parseAdminBase('  ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('round-trips a base into a link without ever reconstructing userinfo', () => {
    const base = baseOf(parseAdminBase('http://192.168.10.89:8123'))
    const url = urlOf(
      buildDeviceAdminUrl({
        host: base.host,
        port: base.port,
        scheme: base.scheme,
        path: `${base.basePath}/config/devices/device/bf38dbc6816ab9fdbd7f8f6b1eb4638b`,
      }),
    )
    expect(url).toBe(
      'http://192.168.10.89:8123/config/devices/device/bf38dbc6816ab9fdbd7f8f6b1eb4638b',
    )
  })
})
