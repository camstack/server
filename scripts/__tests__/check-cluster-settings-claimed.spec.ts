import { describe, expect, it } from 'vitest'
import {
  CLUSTER_SETTINGS_CLAIMS,
  type ClusterSettingsClaim,
} from '../../packages/addon-admin-ui/src/lib/cluster-settings-claims'
import { findClusterClaimFindings } from '../check-cluster-settings-claimed'
import { clusterSchemaCapsIn } from '../check-scoped-settings-declared'

const claim = (cap: string, surface: ClusterSettingsClaim['surface']): ClusterSettingsClaim => ({
  cap,
  addonId: cap,
  surface,
})

describe('check-cluster-settings-claimed', () => {
  it('passes when every declared cap is claimed once', () => {
    expect(
      findClusterClaimFindings(
        [{ cap: 'alerts', file: 'a.ts' }],
        [claim('alerts', 'notifications')],
      ),
    ).toEqual([])
  })

  it('fails on a cluster schema nobody claims', () => {
    const findings = findClusterClaimFindings([{ cap: 'new-thing', file: 'n.ts' }], [])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('no surface claims it')
  })

  it('fails on a cap claimed by two surfaces', () => {
    const findings = findClusterClaimFindings(
      [{ cap: 'snapshot', file: 's.ts' }],
      [claim('snapshot', 'pipeline'), claim('snapshot', 'addon-card')],
    )
    expect(findings.some((f) => f.includes('claimed 2 times'))).toBe(true)
  })

  it('fails on a stale claim', () => {
    const findings = findClusterClaimFindings([], [claim('gone', 'history')])
    expect(findings[0]).toContain('matches no clusterSettingsSchema hook')
  })

  it('reads the caps a cluster hook answers for, and skips one that returns null', () => {
    const source = `
class X {
  protected override async clusterSettingsSchema(cap: string) {
    if (cap !== 'snapshot') return null
    return { sections: [] }
  }
  protected override async nodeSettingsSchema(cap: string) {
    return cap === 'node-only' ? { sections: [] } : null
  }
}
class Y {
  protected override async clusterSettingsSchema(cap: string) {
    return null
  }
}`
    expect(clusterSchemaCapsIn(source)).toEqual(['snapshot'])
  })

  it('the real claim table names each cap once', () => {
    const caps = CLUSTER_SETTINGS_CLAIMS.map((c) => c.cap)
    expect(new Set(caps).size).toBe(caps.length)
  })
})
