/**
 * The Pipeline cards draw only what the claim table gives the `pipeline` surface, and an addon
 * dialog leaves out exactly the capabilities a feature page claims (#578).
 */
import { describe, expect, it } from 'vitest'
import {
  CLUSTER_SETTINGS_CLAIMS,
  CLUSTER_SETTINGS_SURFACE_ROUTES,
  featureClaimsOf,
} from '../cluster-settings-claims'
import { CLUSTER_SETTINGS_SECTIONS } from '../../components/pipeline/tabs/cluster-settings-sections'

describe('cluster settings claims', () => {
  it('every Pipeline card panel that names a capability draws a pipeline claim of that addon', () => {
    const panels = CLUSTER_SETTINGS_SECTIONS.flatMap((s) => s.panels).filter(
      (p) => p.capability !== undefined,
    )
    expect(panels.length).toBeGreaterThan(0)
    for (const panel of panels) {
      const claim = CLUSTER_SETTINGS_CLAIMS.find((c) => c.cap === panel.capability)
      expect(claim, panel.capability).toMatchObject({ addonId: panel.addonId, surface: 'pipeline' })
    }
  })

  it('every capability claimed for the pipeline surface is drawn by a Pipeline card', () => {
    const drawnCaps = new Set(
      CLUSTER_SETTINGS_SECTIONS.flatMap((s) => s.panels).flatMap((p) =>
        p.capability !== undefined ? [p.capability] : [p.addonId],
      ),
    )
    for (const claim of CLUSTER_SETTINGS_CLAIMS.filter((c) => c.surface === 'pipeline')) {
      expect(drawnCaps.has(claim.cap), claim.cap).toBe(true)
    }
  })

  it('an addon dialog omits feature-page claims only, never its own fallback ones', () => {
    expect(featureClaimsOf('pipeline-analytics').map((c) => c.cap)).toEqual(['face-gallery'])
    expect(featureClaimsOf('model-studio')).toEqual([])
    expect(featureClaimsOf('osd-manager')).toEqual([])
    expect(featureClaimsOf('stream-broker').map((c) => c.surface)).toEqual(['pipeline'])
  })

  it('every feature surface has a route to link to', () => {
    const surfaces = new Set(CLUSTER_SETTINGS_CLAIMS.map((c) => c.surface))
    for (const s of ['pipeline', 'history', 'notifications', 'nodes'] as const) {
      expect(surfaces.has(s)).toBe(true)
      expect(CLUSTER_SETTINGS_SURFACE_ROUTES[s]).toMatch(/^\/system\//)
    }
  })
})
