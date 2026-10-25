/**
 * The public-working-docs guard. Every value below is FAKE — a spec in a public
 * repo is no place to prove the guard on the real names it hashes, so the
 * private-term case injects its own hash set.
 */
import { describe, expect, it } from 'vitest'
import {
  type AllowlistEntry,
  SCOPES,
  NAS_MOUNT_EXEMPT_PREFIXES,
  applyAllowlist,
  findPrivateData,
  type PrivateCategory,
  termHash,
} from '../check-public-docs-private-data.js'

const FAKE_TERMS: ReadonlySet<string> = new Set([termHash('zebedeo')])

const categories = (text: string): readonly PrivateCategory[] =>
  findPrivateData(text, 'x.md', { termHashes: FAKE_TERMS }).map((f) => f.category)

describe('what the guard refuses', () => {
  it.each([
    ['a LAN address with a port', 'hub at 192.168.10.20:4443', 'lan-ip'],
    ['a 10/8 address', 'reach 10.20.30.40 first', 'lan-ip'],
    ['a 172.16/12 address', 'bridge 172.20.0.3', 'lan-ip'],
    ['a Tailscale address', 'ssh root@100.101.102.103', 'lan-ip'],
    ['a home directory', 'see /Users/someone/Documents/x', 'host-path'],
    ['a NAS pool path', 'data under /mnt/user/appdata', 'host-path'],
    ['a session scratchpad', 'wrote /private/tmp/claude-501/abc/scratchpad/x', 'host-path'],
    ['an e-mail address', 'mail foo.bar@corp-mail.it', 'email'],
    ['an npm token', 'Token=npm_AbCdEf123456', 'token'],
    ['a GitHub token', 'gh auth ghp_Zx9Yw8Vu7Ts6', 'token'],
    ['a JWT', 'Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'token'],
    ['a quoted secret value', `jwtSecret: 'q7Rk2mPz9vXc4LbT'`, 'token'],
    ['a MAC address', 'mac 3c:22:fb:01:aa:9e', 'mac'],
    ['a real-looking plate', 'plate GH482KL read', 'plate'],
    ['a serial number', 'serialNumber: "QX81PL0042"', 'serial'],
    ['a private name', 'face enrolled as Zebedeo', 'private-term'],
    ['a private name inside camelCase', 'const zebedeoAway = 1', 'private-term'],
    ['a private name in SCREAMING_SNAKE', 'ZEBEDEO_FROM = 2', 'private-term'],
  ] as const)('%s', (_label, text, category) => {
    expect(categories(text)).toContain(category)
  })
})

describe('what the guard lets through', () => {
  it.each([
    ['placeholders', 'hub at <hub-ip>:4443, repo <repo>/x, <scratchpad>/y, Person A'],
    ['the CGNAT range literal', 'Tailscale uses 100.64.0.0/10'],
    ['a public or documentation address', 'resolve 198.51.100.5 and 8.8.8.8'],
    ['a commit trailer e-mail', 'Co-Authored-By: Claude <noreply@anthropic.com>'],
    ['a package@version', 'installed sharp@0.35.2'],
    ['a synthetic plate fixture', "text: 'AB123CD' vs 'ZZ999ZZ'"],
    ['a fixture secret', `apiKey: 'sk-secret-value-1234'`],
    ['an env var name', 'npm_config_cache is set'],
    ['a code span after token', 'token = `SuctionLevel`'],
    ['camera ids and node ids', 'camera 101 on node agent-a'],
  ] as const)('%s', (_label, text) => {
    expect(categories(text)).toEqual([])
  })

  // The NAS host word is in the REAL hash set; it doubles as an ML term.
  const real = (text: string): readonly PrivateCategory[] =>
    findPrivateData(text, 'x.md').map((f) => f.category)

  it('the ML sense of the NAS host word', () => {
    expect(real('the text tower and the vision tower; TextTower')).toEqual([])
  })

  it('still flags the NAS host word when it is a host', () => {
    expect(real('built on the `tower` runner')).toContain('private-term')
  })
})

describe('docs/design scope', () => {
  const inDir = (file: string, text: string): readonly PrivateCategory[] =>
    findPrivateData(text, file, { termHashes: FAKE_TERMS }).map((f) => f.category)

  it('is scanned', () => {
    expect(SCOPES).toContain('docs/design')
  })
  it('flags a LAN address and a home path in a design record', () => {
    expect(inDir('docs/design/x.md', 'hub at 192.168.10.20:4443')).toEqual(['lan-ip'])
    expect(inDir('docs/design/x.md', 'see /Users/someone/Documents/x')).toEqual(['host-path'])
  })
  it('lets a NAS pool path through in a design record only', () => {
    expect(inDir('docs/design/x.md', 'data under /mnt/user/appdata')).toEqual([])
    expect(inDir('docs/notes/x.md', 'data under /mnt/user/appdata')).toEqual(['host-path'])
  })
})

describe('moved trees are not a scope', () => {
  const inDir = (file: string, text: string): readonly PrivateCategory[] =>
    findPrivateData(text, file, { termHashes: FAKE_TERMS }).map((f) => f.category)

  it('does not scan the diary or the working-note trees', () => {
    expect(SCOPES).not.toContain('docs/history')
    expect(SCOPES).not.toContain('docs/superpowers')
    expect(SCOPES).not.toContain('.superpowers')
    expect(NAS_MOUNT_EXEMPT_PREFIXES).not.toContain('docs/history/')
  })

  it('does not treat a former diary path as a NAS exemption', () => {
    expect(inDir('docs/history/sessions/2026-10.md', 'data under /mnt/user/appdata')).toEqual([
      'host-path',
    ])
  })
})

describe('allowlist', () => {
  const finding = findPrivateData('fixture /mnt/ok here', 'a.md')
  const entry: AllowlistEntry = { file: 'a.md', match: '/mnt/ok', why: 'fixture' }

  it('suppresses an exact (file, match) pair', () => {
    expect(applyAllowlist(finding, [entry]).remaining).toEqual([])
  })

  it('does not suppress the same match in another file', () => {
    expect(applyAllowlist(finding, [{ ...entry, file: 'b.md' }]).remaining).toHaveLength(1)
  })

  it('reports an entry that matches nothing as unused', () => {
    expect(applyAllowlist([], [entry]).unused).toEqual([entry])
  })
})
