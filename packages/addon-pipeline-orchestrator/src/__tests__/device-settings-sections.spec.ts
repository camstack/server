import { describe, expect, it } from 'vitest'
import { buildDeviceSettingsSections } from '../settings-ui-schemas.js'

function fieldKeys(sectionId: string): string[] {
  const sections = buildDeviceSettingsSections({ runnerNodeIds: ['hub', 'agent-1'] })
  const section = sections.find((s) => s.id === sectionId)
  if (!section) throw new Error(`section ${sectionId} not found`)
  return section.fields.flatMap((f) => ('key' in f && typeof f.key === 'string' ? [f.key] : []))
}

describe('buildDeviceSettingsSections — Cluster Assignment', () => {
  it('keeps the pipeline node pin', () => {
    expect(fieldKeys('cluster-assignment')).toContain('pipelineNodeId')
  })

  it('no longer exposes the deprecated per-device Audio Node pin', () => {
    // Audio runs on the cluster-wide `clusterRoles.audioNode` singleton role;
    // the per-camera `audioNodeId` selector was removed (dormant legacy
    // escape hatch remains in the balancer but is no longer operator-set).
    expect(fieldKeys('cluster-assignment')).not.toContain('audioNodeId')
  })
})
