/**
 * The admin pages draw exactly what the claim table says (#578). The guard
 * (`scripts/check-cluster-settings-claimed.ts`) holds the claims to the addons'
 * schemas; this spec holds the pages to the claims — together a section added
 * to a cap, or a card removed from a page, turns one of them red.
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_MODEL_SECTION_ID,
  CLUSTER_STEP_SETTING_FIELDS,
  clusterModelSettingKey,
  clusterStepSettingKey,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  addonDialogOmissions,
  CLUSTER_SETTINGS_CLAIMS,
  CLUSTER_SETTINGS_SURFACE_ROUTES,
  type ClusterSettingsClaim,
  featureClaimsOf,
  isWholeClaim,
} from '../cluster-settings-claims'
import {
  CLUSTER_SETTINGS_SECTIONS,
  type ClusterSettingsPanel,
} from '../../components/pipeline/tabs/cluster-settings-sections'
import {
  ANALYTICS_CAP,
  ORCHESTRATOR_CAP,
  POST_PROCESSING_NODE_KEY,
  RECORDER_CAP,
  RECORDING_NODE_KEY,
  ROLE_FIELDS,
} from '../../components/pipeline/placement-board/board-model'

const PANELS = CLUSTER_SETTINGS_SECTIONS.flatMap((s) => s.panels)
const claimsOn = (surface: ClusterSettingsClaim['surface']) =>
  CLUSTER_SETTINGS_CLAIMS.filter((c) => c.surface === surface)

/** The cap a panel reads: its `capability`, else the one cap its addon has claims for. */
function capOf(panel: ClusterSettingsPanel): string | undefined {
  if (panel.capability !== undefined) return panel.capability
  const caps = new Set(
    CLUSTER_SETTINGS_CLAIMS.filter((c) => c.addonId === panel.addonId).map((c) => c.cap),
  )
  return caps.size === 1 ? [...caps][0] : undefined
}

/** Every key of the enrichment-models section, as the orchestrator builds it. */
const CLUSTER_MODEL_KEYS = [
  ...CLUSTER_MODEL_SCOPED_STEPS.map((s) => clusterModelSettingKey(s.stepId)),
  ...CLUSTER_STEP_SETTING_FIELDS.map((f) => clusterStepSettingKey(f.stepId, f.key)),
].sort()

/**
 * The sections the Pipeline cards draw of a cap that is split (no whole panel). Field-key panels
 * count as the enrichment-models section only when together they draw ALL of its keys.
 */
function drawnSections(cap: string): readonly string[] {
  const panels = PANELS.filter((p) => capOf(p) === cap)
  const sections = panels.flatMap((p) => p.sectionIds ?? [])
  const keys = [...new Set(panels.flatMap((p) => p.fieldKeys ?? []))].sort()
  const models = keys.length > 0 && JSON.stringify(keys) === JSON.stringify(CLUSTER_MODEL_KEYS)
  return [...sections, ...(models ? [CLUSTER_MODEL_SECTION_ID] : [])].sort()
}

describe('cluster settings claims — the Pipeline cards', () => {
  it('draw every section a split pipeline claim names, and nothing more', () => {
    const split = claimsOn('pipeline').filter((c) => !isWholeClaim(c))
    expect(split.map((c) => c.cap)).toEqual(['pipeline-orchestrator'])
    for (const claim of split) {
      expect(drawnSections(claim.cap), claim.cap).toEqual([...(claim.sectionIds ?? [])].sort())
    }
  })

  it('draw a whole pipeline claim with one un-narrowed panel that omits exactly the fields drawn elsewhere', () => {
    for (const claim of claimsOn('pipeline').filter(isWholeClaim)) {
      const panels = PANELS.filter((p) => capOf(p) === claim.cap)
      expect(panels, claim.cap).toHaveLength(1)
      const [panel] = panels
      expect(panel?.addonId, claim.cap).toBe(claim.addonId)
      expect(panel?.sectionIds, claim.cap).toBeUndefined()
      expect(panel?.fieldKeys, claim.cap).toBeUndefined()
      const elsewhere = CLUSTER_SETTINGS_CLAIMS.filter(
        (c) => c.cap === claim.cap && c !== claim,
      ).flatMap((c) => c.fieldKeys ?? [])
      expect([...(panel?.omitFieldKeys ?? [])].sort(), claim.cap).toEqual(elsewhere.sort())
    }
  })

  it('draw no claimed cap that the claims give to another surface', () => {
    const pipelineCaps = new Set(claimsOn('pipeline').map((c) => c.cap))
    const claimedCaps = new Set(CLUSTER_SETTINGS_CLAIMS.map((c) => c.cap))
    for (const panel of PANELS) {
      const cap = capOf(panel)
      if (cap === undefined || !claimedCaps.has(cap)) continue
      expect(pipelineCaps.has(cap), cap).toBe(true)
    }
  })
})

describe('cluster settings claims — Roles & nodes', () => {
  it('has one picker for every field claimed for it', () => {
    const fieldOfRole: Readonly<Record<(typeof ROLE_FIELDS)[number], readonly [string, string]>> = {
      ingestNode: [ORCHESTRATOR_CAP, 'ingestNode'],
      audioNode: [ORCHESTRATOR_CAP, 'audioNode'],
      motionNode: [ORCHESTRATOR_CAP, 'motionNode'],
      recordingNode: [RECORDER_CAP, RECORDING_NODE_KEY],
      postProcessingNode: [ANALYTICS_CAP, POST_PROCESSING_NODE_KEY],
    }
    const drawn = ROLE_FIELDS.map((role) => fieldOfRole[role].join(':')).sort()
    const claimed = claimsOn('pipeline-roles')
      .flatMap((c) => (c.fieldKeys ?? []).map((k) => `${c.cap}:${k}`))
      .sort()
    expect(claimed).toEqual(drawn)
  })
})

describe('cluster settings claims — the addon dialog', () => {
  it('leaves out what a feature page draws, and keeps its own fallback forms', () => {
    expect(addonDialogOmissions('pipeline-analytics')).toEqual({
      capabilities: ['face-gallery'],
      fieldKeys: ['postProcessingNodeId'],
    })
    expect(addonDialogOmissions('pipeline-orchestrator')).toEqual({
      capabilities: ['pipeline-orchestrator'],
      fieldKeys: [],
    })
    expect(addonDialogOmissions('recorder')).toEqual({ capabilities: ['recording'], fieldKeys: [] })
    expect(addonDialogOmissions('model-studio')).toEqual({ capabilities: [], fieldKeys: [] })
    expect(addonDialogOmissions('osd-manager')).toEqual({ capabilities: [], fieldKeys: [] })
  })

  it('links to every page that draws part of the addon', () => {
    expect([...new Set(featureClaimsOf('pipeline-analytics').map((c) => c.surface))]).toEqual([
      'pipeline',
      'pipeline-roles',
    ])
    expect(featureClaimsOf('model-studio')).toEqual([])
  })

  it('every feature surface has a route to link to', () => {
    for (const c of CLUSTER_SETTINGS_CLAIMS) {
      if (c.surface === 'addon-card' || c.surface === 'provider-page') continue
      expect(CLUSTER_SETTINGS_SURFACE_ROUTES[c.surface], c.surface).toMatch(/^\/system\//)
    }
  })
})
