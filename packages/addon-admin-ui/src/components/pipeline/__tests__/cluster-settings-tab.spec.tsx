/// <reference types="@testing-library/jest-dom" />
/**
 * Cluster → Settings is one titled card per SUBJECT, whichever addon stores
 * the value:
 *
 *   - Faces & recognition holds the face encoder AND the face-gallery cap's
 *     matching knobs (before: the encoder at the top, matching at the bottom);
 *   - the cluster-scoped encoders are drawn exactly once on the page;
 *   - the runner and audio-backend values the node page used to show under a
 *     node's name (stored cluster-wide, audit B7) are here, as cluster values.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_STEP_SETTING_FIELDS,
  clusterModelSettingKey,
  clusterStepSettingKey,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  CLUSTER_SETTINGS_SECTIONS,
  settingsSectionForStep,
} from '../tabs/cluster-settings-sections'

expect.extend(jestDomMatchers)

interface PanelProps {
  readonly addonIds: readonly string[]
  readonly capability?: string
  readonly fieldKeys?: readonly string[]
  readonly sectionIds?: readonly string[]
  readonly fieldScope?: string
  readonly omitSectionIds?: readonly string[]
}

vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: PanelProps) => (
    <div
      data-testid="panel"
      data-addon={props.addonIds.join(',')}
      data-cap={props.capability ?? ''}
      data-keys={(props.fieldKeys ?? []).join(',')}
      data-sections={(props.sectionIds ?? []).join(',')}
      data-scope={props.fieldScope ?? ''}
      data-omit={(props.omitSectionIds ?? []).join(',')}
    />
  ),
}))

import { ClusterSettingsTab } from '../tabs/ClusterSettingsTab'

function renderTab(): void {
  render(
    <MemoryRouter>
      <ClusterSettingsTab refreshToken={0} />
    </MemoryRouter>,
  )
}

function card(title: string): HTMLElement {
  return screen.getByRole('region', { name: title })
}

describe('Cluster → Settings', () => {
  it('is one titled card per subject, faces first', () => {
    renderTab()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Faces & recognition',
      'Semantic search',
      'Enrichment crop',
      'Full-resolution crops',
      'Runner defaults',
      'Load balancer',
      'Failover',
    ])
  })

  it('Faces & recognition holds the face encoder, its size floor and the matching knobs', () => {
    renderTab()
    const panels = within(card('Faces & recognition')).getAllByTestId('panel')
    expect(panels.map((p) => p.dataset.addon)).toEqual([
      'pipeline-orchestrator',
      'pipeline-analytics',
    ])
    expect(panels[0]?.dataset.keys).toBe(
      [
        clusterModelSettingKey('face-embedding'),
        clusterStepSettingKey('face-embedding', 'minLandmarkFaceSize'),
      ].join(','),
    )
    expect(panels[1]?.dataset.cap).toBe('face-gallery')
  })

  it('draws every cluster-scoped encoder and knob exactly once', () => {
    renderTab()
    const drawn = screen
      .getAllByTestId('panel')
      .flatMap((p) => (p.dataset.keys === '' ? [] : (p.dataset.keys ?? '').split(',')))
    const expected = [
      ...CLUSTER_MODEL_SCOPED_STEPS.map((s) => clusterModelSettingKey(s.stepId)),
      ...CLUSTER_STEP_SETTING_FIELDS.map((f) => clusterStepSettingKey(f.stepId, f.key)),
    ]
    expect(drawn.toSorted()).toEqual(expected.toSorted())
  })

  it('the runner and audio-backend values are drawn as CLUSTER values', () => {
    renderTab()
    const panels = within(card('Runner defaults')).getAllByTestId('panel')
    expect(panels.map((p) => [p.dataset.addon, p.dataset.scope])).toEqual([
      ['pipeline-runner', 'cluster'],
      ['audio-analyzer', 'cluster'],
    ])
  })

  it('the Load balancer card draws the orchestrator `load` section, and no other panel does', () => {
    renderTab()
    const panels = within(card('Load balancer')).getAllByTestId('panel')
    expect(panels.map((p) => [p.dataset.addon, p.dataset.sections, p.dataset.omit])).toEqual([
      ['pipeline-orchestrator', 'load', 'cluster'],
    ])
    const drawsLoad = screen
      .getAllByTestId('panel')
      .filter((p) => !(p.dataset.omit ?? '').split(',').includes('load'))
    expect(drawsLoad).toHaveLength(1)
  })

  it('a cluster-scoped step links to the card its encoder is edited in', () => {
    expect(settingsSectionForStep('face-embedding')).toBe('faces')
    expect(settingsSectionForStep('clip-embedding')).toBe('semantic-search')
    expect(CLUSTER_SETTINGS_SECTIONS.map((s) => s.id)).toContain('semantic-search')
  })
})
