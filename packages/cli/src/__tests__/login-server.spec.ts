import { describe, expect, it } from 'vitest'
import { formatSessionList } from '../commands/auth.js'
import { resolveLoginServer } from '../commands/login-server.js'

describe('resolveLoginServer', () => {
  it('a positional host is the same as --server', () => {
    expect(resolveLoginServer(undefined, ['192.0.2.20'], {})).toBe('https://192.0.2.20:4443')
    expect(resolveLoginServer('192.0.2.20', [], {})).toBe(
      resolveLoginServer(undefined, ['192.0.2.20'], {}),
    )
  })
  it('the same hub given twice is fine, two different hubs are an error', () => {
    expect(resolveLoginServer('hub.local', ['https://hub.local:4443'], {})).toBe(
      'https://hub.local:4443',
    )
    expect(() => resolveLoginServer('hub.local', ['10.0.0.1'], {})).toThrow(/two different hubs/)
  })
  it('refuses more than one positional and http://', () => {
    expect(() => resolveLoginServer(undefined, ['a', 'b'], {})).toThrow(/one hub address/)
    expect(() => resolveLoginServer(undefined, ['http://a'], {})).toThrow(/https/)
  })
  it('falls back to $CAMSTACK_SERVER, then $CAMSTACK_HUB_URL, then undefined (discover)', () => {
    expect(resolveLoginServer(undefined, [], { CAMSTACK_SERVER: 'a.local' })).toBe(
      'https://a.local:4443',
    )
    expect(resolveLoginServer(undefined, [], { CAMSTACK_HUB_URL: 'b.local:9000' })).toBe(
      'https://b.local:9000',
    )
    expect(resolveLoginServer(undefined, [], {})).toBeUndefined()
    expect(resolveLoginServer('flag.local', [], { CAMSTACK_SERVER: 'a.local' })).toBe(
      'https://flag.local:4443',
    )
  })
})

describe('formatSessionList', () => {
  const s = (server: string, lastUsedAt: number) => ({
    server,
    username: 'admin',
    tokenId: 't',
    token: 'tok_x',
    scopes: [{ type: 'capability', target: 'addons' }],
    createdAt: 1,
    lastUsedAt,
  })
  it('lists every session and marks only the default', () => {
    const out = formatSessionList(
      [
        { ...s('https://a:4443', 2000), isAdmin: true },
        s('https://b:4443', 1000),
        s('https://c:4443', 500),
      ],
      'https://a:4443',
    )
    const lines = out.split('\n')
    expect(lines[0]).toContain('3 saved sessions')
    expect(lines.filter((l) => l.startsWith('*'))).toEqual(['* https://a:4443'])
    for (const host of ['a', 'b', 'c']) expect(out).toContain(` https://${host}:4443`)
    expect(out).toContain('admin: yes')
    expect(out).toContain('admin: no')
    expect(out).toContain('capability:addons')
  })
})
