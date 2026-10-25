import { describe, it, expect } from 'vitest'
import { maskUrlCredentials } from '../mask-url.js'

describe('maskUrlCredentials', () => {
  it('returns the input unchanged when no credentials present', () => {
    expect(maskUrlCredentials('rtsp://192.168.10.170:554/h264Preview_01_main')).toBe(
      'rtsp://192.168.10.170:554/h264Preview_01_main',
    )
  })

  it('strips userinfo (user:pass@host)', () => {
    expect(
      maskUrlCredentials('rtsp://admin:secret@192.168.10.170:554/Streaming/Channels/101'),
    ).toBe('rtsp://192.168.10.170:554/Streaming/Channels/101')
  })

  it('strips userinfo when only username is present', () => {
    expect(maskUrlCredentials('http://user@example.com/feed')).toBe('http://example.com/feed')
  })

  it('masks credential-shaped query params (case-insensitive)', () => {
    // Reolink RTMP shape — credentials in query string, not userinfo.
    const masked = maskUrlCredentials(
      'rtmp://192.168.10.170:1935/bcs/channel0_main.bcs?channel=0&stream=0&user=admin&password=secret-redacted',
    )
    expect(masked).not.toContain('secret-redacted')
    expect(masked).not.toContain('admin')
    expect(masked).toContain('user=***')
    expect(masked).toContain('password=***')
    // Non-credential params are preserved verbatim.
    expect(masked).toContain('channel=0')
    expect(masked).toContain('stream=0')
  })

  it('masks tokens / api keys / auth headers in query', () => {
    const masked = maskUrlCredentials(
      'https://api.example.com/v1/cameras?token=abc123&apikey=xyz789&bearer=foo&authToken=bar',
    )
    expect(masked).not.toMatch(/abc123|xyz789|foo|bar/)
    expect(masked).toContain('token=***')
    expect(masked).toContain('apikey=***')
    expect(masked).toContain('bearer=***')
    expect(masked).toContain('authToken=***')
  })

  it('masks common variants: pwd, pass, secret', () => {
    const masked = maskUrlCredentials('http://device.local/api?usr=alice&pwd=hunter2&secret=shh')
    expect(masked).toContain('usr=***')
    expect(masked).toContain('pwd=***')
    expect(masked).toContain('secret=***')
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('shh')
  })

  it('case-insensitive param name matching', () => {
    const masked = maskUrlCredentials('http://x/y?Password=p1&UserName=u1&API_KEY=k1')
    expect(masked).toContain('Password=***')
    expect(masked).toContain('UserName=***')
    expect(masked).toContain('API_KEY=***')
  })

  it('combines userinfo stripping + query-param masking', () => {
    const masked = maskUrlCredentials('rtsp://admin:secret@cam.local/stream?token=xyz&codec=h264')
    expect(masked).not.toContain('secret')
    expect(masked).not.toContain('xyz')
    expect(masked).toContain('rtsp://cam.local/stream')
    expect(masked).toContain('token=***')
    expect(masked).toContain('codec=h264')
  })

  it('returns the original string unchanged when input is not a valid URL', () => {
    expect(maskUrlCredentials('not-a-url')).toBe('not-a-url')
    expect(maskUrlCredentials('')).toBe('')
  })

  it('leaves non-credential params untouched (no false positives)', () => {
    const masked = maskUrlCredentials(
      'http://api.example.com/search?q=admin&user_id=42&topic=password-reset',
    )
    // `q`, `user_id`, `topic` are NOT credential names — preserve verbatim.
    // (`user_id` ends in `_id` so it's an entity ref, not a credential.)
    expect(masked).toContain('q=admin')
    expect(masked).toContain('user_id=42')
    expect(masked).toContain('topic=password-reset')
  })

  it('masks the one-time sign-in hand-off params: bridge, code, state, challenge, link', () => {
    const masked = maskUrlCredentials(
      'https://hub.example/api/auth/sso/finish?bridge=eyJ.abc.def&popup=1',
    )
    expect(masked).not.toContain('eyJ.abc.def')
    expect(masked).toContain('bridge=***')
    expect(masked).toContain('popup=1')
    const callback = maskUrlCredentials(
      'https://hub.example/addon/auth-oidc/a/callback?code=CODE123&state=STATE456',
    )
    expect(callback).not.toContain('CODE123')
    expect(callback).not.toContain('STATE456')
  })

  it('masks the native app PKCE challenge on the app sign-in start (D858)', () => {
    const start = maskUrlCredentials(
      'https://hub.example/addon/auth-oidc/a/start?app=1&code_challenge=CHAL789&code_challenge_method=S256&state=APPSTATE',
    )
    expect(start).not.toContain('CHAL789')
    expect(start).not.toContain('APPSTATE')
    expect(start).toContain('code_challenge_method=S256')
    expect(maskUrlCredentials('https://hub.example/auth/app/confirm?confirm=TOK123')).not.toContain(
      'TOK123',
    )
  })

  it('masks a RELATIVE URL too (request logs carry paths, not absolute URLs)', () => {
    const masked = maskUrlCredentials('/api/auth/sso/finish?bridge=eyJ.abc.def&popup=1')
    expect(masked).toBe('/api/auth/sso/finish?bridge=***&popup=1')
  })
})
