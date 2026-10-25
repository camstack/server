import type { PackageInstallation } from '@camstack/types'
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
  row('@camstack/addon-decoder-ffmpeg', 'agent-a', false),
  row('@camstack/addon-decoder-ffmpeg', 'mac', false),
  row('@camstack/addon-pipeline', 'mac', true),
  row('@camstack/addon-pipeline', 'hub', true, true),
  row('@camstack/addon-agent-ui', 'mac', false),
  row('@camstack/system', 'mac', false),
]

describe('groupNodeOnlyPackages', () => {
  it('hub view: every agent copy the hub does not install, grouped by package', () => {
    const groups = groupNodeOnlyPackages(ROWS, { id: 'hub', name: 'Hub', isHub: true })
    expect(groups.map((g) => [g.packageName, g.rows.map((r) => r.nodeId)])).toEqual([
      ['@camstack/addon-decoder-ffmpeg', ['agent-a', 'mac']],
    ])
  })

  it('agent view: only that agent, and never its self-managed bootstrap', () => {
    const groups = groupNodeOnlyPackages(ROWS, { id: 'mac', name: 'mac', isHub: false })
    expect(groups.map((g) => [g.packageName, g.rows.map((r) => r.nodeId)])).toEqual([
      ['@camstack/addon-decoder-ffmpeg', ['mac']],
    ])
  })
})
