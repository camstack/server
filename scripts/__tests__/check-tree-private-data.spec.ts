/**
 * The whole-tree scrub guard. Values here are FAKE — the real terms are hashes
 * in the guard, and a spec must not reprint them.
 */
import { describe, expect, it } from 'vitest'
import { termHash } from '../check-public-docs-private-data.js'
import { type TreePrivateCategory, findTreePrivateData } from '../check-tree-private-data.js'

const FAKE = {
  person: new Set([termHash('zebedeo')]),
  host: new Set([termHash('runnerz')]),
  room: new Set([termHash('atrium')]),
  homeIp: new Set([termHash('203.0.113.9')]),
  cameraId: new Set([termHash('4242')]),
}

const categories = (text: string, file = 'x.md'): readonly TreePrivateCategory[] =>
  findTreePrivateData(text, file, FAKE).map((f) => f.category)

describe('tree scrub guard', () => {
  it('flags a person, a host, a room, a home address and a camera id', () => {
    expect(categories('enrolled Zebedeo')).toContain('person')
    expect(categories('node runnerz')).toContain('host')
    expect(categories("location: 'Atrium'")).toContain('room')
    expect(categories('hub at 203.0.113.9:8443')).toContain('home-ip')
    expect(categories('deviceId: 4242 on camera 1')).toContain('camera-id')
  })

  it('lets documentation addresses, decimals, resolutions and file:line refs through', () => {
    expect(categories('resolve 192.0.2.10 and 198.51.100.5')).toEqual([])
    expect(categories('score 0.4242 and 4242x360')).toEqual([])
    expect(categories('see file.ts:4242 for the width')).toEqual([])
    expect(categories('yolo model 4242')).toEqual([])
  })

  it('does not treat a workflow runs-on label as a host leak', () => {
    expect(
      categories('runs-on: [self-hosted, linux, runnerz]', '.github/workflows/ci.yml'),
    ).toEqual([])
  })

  it('keeps the ML sense of the NAS host word', () => {
    expect(
      findTreePrivateData(
        'the text tower and EmbeddingTower; a tower keeps crashing in TowerBudgets',
        'x.ts',
      ).map((f) => f.match),
    ).toEqual([])
  })

  it('allows the security contact only in SECURITY.md and the issue chooser', () => {
    const address = 'kept-out@other.test'
    const options = { ...FAKE, securityContactHash: termHash(address) }
    expect(
      findTreePrivateData(`write ${address}`, 'README.md', options).map((f) => f.category),
    ).toEqual(['email'])
    expect(findTreePrivateData(`write ${address}`, 'CONTRIBUTING.md', options)).toHaveLength(1)
    expect(findTreePrivateData(`write ${address}`, 'SECURITY.md', options)).toEqual([])
    expect(
      findTreePrivateData(`mailto:${address}`, '.github/ISSUE_TEMPLATE/config.yml', options),
    ).toEqual([])
  })
})
