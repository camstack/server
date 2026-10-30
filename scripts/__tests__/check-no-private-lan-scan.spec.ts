import { describe, expect, it } from 'vitest'
import { ALLOWLIST, findPrivateLanScans } from '../check-no-private-lan-scan.ts'

const file = (rel: string, content: string) => ({ rel, content })
const ADDON = 'packages/addon-provider-example/src/scan.ts'

describe('check-no-private-lan-scan', () => {
  it('flags dgram, interface walks, multicast literals and /24 sweeps', () => {
    const { findings } = findPrivateLanScans(
      [
        file(ADDON, "import { createSocket } from 'node:dgram'"),
        file(ADDON + '2', 'const ifaces = os.networkInterfaces()'),
        file(ADDON + '3', "const GROUP = '224.0.0.251'"),
        file(ADDON + '4', "const WSD = '239.255.255.250'"),
        file(ADDON + '5', 'for (let d = 1; d <= 254; d += 1) hosts.push(d)'),
      ],
      {},
    )
    expect(findings.map((f) => f.rule)).toEqual([
      'dgram',
      'networkInterfaces',
      'multicast address literal',
      'multicast address literal',
      '/24 sweep loop',
    ])
  })

  it('ignores comments and ordinary addresses', () => {
    const { findings } = findPrivateLanScans(
      [
        file(
          ADDON,
          ['// uses dgram in the engine', ' * networkInterfaces', "const ip = '192.0.2.10'"].join(
            '\n',
          ),
        ),
      ],
      {},
    )
    expect(findings).toEqual([])
  })

  it('lets an allowlisted file through, and fails an allowlist entry nothing matches', () => {
    const allow = { [ADDON]: 'reason', 'packages/addon-gone/src/x.ts': 'reason' }
    const report = findPrivateLanScans(
      [
        file(ADDON, "import dgram from 'node:dgram'"),
        file('packages/addon-gone/src/x.ts', 'const a = 1'),
      ],
      allow,
    )
    expect(report.findings).toEqual([])
    expect(report.staleAllowlist).toEqual(['packages/addon-gone/src/x.ts'])
  })

  it('gives every allowlist entry a reason', () => {
    for (const [file_, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, file_).toBeGreaterThan(20)
    }
  })
})
