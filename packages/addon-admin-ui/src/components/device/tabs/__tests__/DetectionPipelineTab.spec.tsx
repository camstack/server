import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LeadingSettingsTab } from '../../../form-builder/TabbedSettingsForm'

// DetectionPipelineTab is a thin shell: ONE tab bar made of a leading Steps
// tab plus the settings groups, all inside one DeviceAggregateSection (one
// save controller). The aggregate is stubbed to expose what it was handed.

vi.mock('../CameraStepInspector', () => ({
  CameraStepInspector: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="steps-surface">steps for {deviceId}</div>
  ),
}))

interface AggregateProps {
  readonly deviceId: number
  readonly activeSubTab?: string | null
  readonly leadingTabs?: readonly LeadingSettingsTab[]
  readonly subTabGrouping?: { readonly tabs: ReadonlyArray<{ readonly id: string }> }
}

const seen: { current: AggregateProps | null } = { current: null }

vi.mock('../DeviceAggregateSection', () => ({
  DeviceAggregateSection: (props: AggregateProps) => {
    seen.current = props
    return <div data-testid="aggregate">{props.leadingTabs?.[0]?.content}</div>
  },
}))

import { DetectionPipelineTab } from '../DetectionPipelineTab'

describe('DetectionPipelineTab', () => {
  it('hands Steps to the aggregate as its leading tab, ahead of the groups', () => {
    render(<DetectionPipelineTab deviceId={7} />)
    expect(seen.current?.leadingTabs?.map((t) => t.id)).toEqual(['steps'])
    expect(seen.current?.subTabGrouping?.tabs[0]?.id).toBe('zones')
    expect(screen.getByTestId('steps-surface').textContent).toContain('steps for 7')
  })

  it('passes a tab id straight through', () => {
    render(<DetectionPipelineTab deviceId={7} activeSubTab="tracking" />)
    expect(seen.current?.activeSubTab).toBe('tracking')
  })

  it('maps the legacy sub=settings to object-detection', () => {
    render(<DetectionPipelineTab deviceId={7} activeSubTab="settings" />)
    expect(seen.current?.activeSubTab).toBe('object-detection')
  })
})
