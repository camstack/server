import { describe, expect, it } from 'vitest'
import { createRedactor, describeRedactions, totalRedactions } from '../mcp/report-scrub.js'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'

const FIXTURE: readonly { readonly raw: string; readonly leak: string }[] = [
  {
    raw: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123`,
    leak: 'abcdefghijklmnopqrstuvwxyz0123',
  },
  { raw: `jwt ${JWT}`, leak: JWT },
  { raw: 'viewer csa_Zk39sdf8sdf8sdf9 connected', leak: 'csa_Zk39sdf8sdf8sdf9' },
  { raw: 'key sk-abcdefghijklmnopqrstuvwx', leak: 'sk-abcdefghijklmnopqrstuvwx' },
  {
    raw: 'marker secret://cloudflare-tunnel/global/tunnelToken here',
    leak: 'secret://cloudflare-tunnel',
  },
  { raw: 'password=hunter2 and token=abc123', leak: 'hunter2' },
  { raw: '{"apiKey":"zzz-value-1","username":"jane"}', leak: 'zzz-value-1' },
  { raw: 'GET /x?token=qwerty99&a=1', leak: 'qwerty99' },
  { raw: 'host 192.168.1.50 and 8.8.8.8', leak: '192.168.1.50' },
  { raw: 'public 8.8.4.4', leak: '8.8.4.4' },
  {
    raw: 'v6 fe80::1ff:fe23:4567:890a and 2001:db8:85a3:0:0:8a2e:370:7334 and ::1',
    leak: '2001:db8',
  },
  { raw: 'mac aa:bb:cc:dd:ee:ff', leak: 'aa:bb:cc:dd:ee:ff' },
  { raw: 'mail jane.doe@example.com now', leak: 'jane.doe' },
  { raw: 'stream rtsp://admin:s3cretpw@cam.local:554/Streaming/Channels/101', leak: 's3cretpw' },
  {
    raw: 'open https://hub.mydomain.com/addon/pipeline-analytics/event-media/o/track/ab12cd34ef56?variant=thumb',
    leak: 'mydomain',
  },
  { raw: 'host nas.home.example.org down', leak: 'example.org' },
  { raw: 'file /Users/jane/.camstack/x and /home/bob/y', leak: '/Users/jane' },
  { raw: 'win C:\\Users\\Jane\\AppData', leak: 'Jane' },
  { raw: 'camera Front Door lost; garage-cam too', leak: 'Front Door' },
]

describe('createRedactor', () => {
  const names = [
    { name: 'Front Door', label: 'device#12' },
    { name: 'garage-cam', label: 'device#13' },
  ]

  it('removes every secret and PII shape', () => {
    const r = createRedactor(names)
    for (const { raw, leak } of FIXTURE) {
      const out = r.scrub(raw)
      expect(out, raw).not.toContain(leak)
    }
    expect(r.scrub('Front Door and garage-cam')).toBe('device#12 and device#13')
  })

  it('counts each redaction by kind', () => {
    const r = createRedactor(names)
    r.scrub('a 10.0.0.1 b 8.8.8.8 c fe80::1ff:fe23:4567:890a')
    r.scrub(`Bearer abcdefghijklmnopqrstuvwx and ${JWT}`)
    r.scrub('rtsp://u:p@cam.local/x')
    r.scrub('mail a@b.com, Front Door')
    const c = r.counts()
    expect(c.ipv4).toBe(2)
    expect(c.ipv6).toBe(1)
    expect(c.tokens).toBe(2)
    expect(c.rtspCredentials).toBe(1)
    expect(c.urls).toBe(1)
    expect(c.emails).toBe(1)
    expect(c.names).toBe(1)
    expect(describeRedactions(c)).toContain('3 IPs')
    expect(describeRedactions(c)).toContain('2 tokens')
    expect(totalRedactions(c)).toBeGreaterThan(8)
  })

  it('keeps only the path shape of a URL', () => {
    const out = createRedactor().scrub('https://x.example.com/a/12345/b?q=1#f')
    expect(out).toBe('[url]/a/:id/b')
  })

  it('leaves code, versions and clock times alone', () => {
    const text = 'ctx.api at index.ts line 4 v1.4.2 at 12:30:45 Object.keys keyFrame: true'
    const r = createRedactor()
    expect(r.scrub(text)).toBe(text)
    expect(totalRedactions(r.counts())).toBe(0)
    expect(describeRedactions(r.counts())).toBe('redacted: nothing')
  })

  it('does not double count a value an earlier pass replaced', () => {
    const r = createRedactor()
    r.scrub('token=csa_abcdefgh1234')
    expect(r.counts().tokens + r.counts().credentials).toBe(1)
  })
})
