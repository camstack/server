import type { PackageInstallation } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { groupNodeOnlyPackages } from '../NodeOnlyPackagesPanel'

function row(
  packageName: string,
  nodeId: string,
  onHub: boolean,
  isHub = false,
): PackageInstallation {
  return {
    packageName,
    nodeId,
    nodeName: nodeId,
    isHub,
    isOnline: true,
    version: '1.0.0',
    addonIds: [],
    source: 'live',
    onHub,
  }
}

const ROWS: readonly PackageInstallation[] = [
  row('@dominevo/addon-decoder-ffmpeg', 'agent-a', false),
  row('@dominevo/addon-decoder-ffmpeg', 'mac', false),
  row('@dominevo/addon-pipeline', 'mac', true),
  row('@dominevo/addon-pipeline', 'hub', true, true),
  row('@dominevo/addon-agent-ui', 'mac', false),
  row('@dominevo/server', 'mac', false),
]

describe('groupNodeOnlyPackages', () => {
  it('hub view: every agent copy the hub does not install, grouped by package', () => {
    const groups = groupNodeOnlyPackages(ROWS, { id: 'hub', name: 'Hub', isHub: true })
    expect(groups.map((g) => [g.packageName, g.rows.map((r) => r.nodeId)])).toEqual([
      ['@dominevo/addon-decoder-ffmpeg', ['agent-a', 'mac']],
    ])
  })

  it('agent view: only that agent, and never its self-managed bootstrap', () => {
    const groups = groupNodeOnlyPackages(ROWS, { id: 'mac', name: 'mac', isHub: false })
    expect(groups.map((g) => [g.packageName, g.rows.map((r) => r.nodeId)])).toEqual([
      ['@dominevo/addon-decoder-ffmpeg', ['mac']],
    ])
  })
})
