import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────
//
// DetectionPipelineTab is a pure LAYOUT shell: it hosts the step matrix (D757)
// and the detection Settings aggregate as two sub-tabs. We stub both heavy
// children (each pulls the full pipeline hook graph) with lightweight markers
// so the test exercises the consolidation wiring only — that BOTH surfaces
// mount under one tab, the Steps/Settings toggle switches between them, and the
// controlled `?sub=` handler fires. The ui-library `Tabs` primitive stays REAL
// so the accessible tab semantics are covered end-to-end.

vi.mock('../CameraStepInspector', () => ({
  CameraStepInspector: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="steps-surface">steps for {deviceId}</div>
  ),
}))

vi.mock('../DeviceAggregateSection', () => ({
  DeviceAggregateSection: ({ deviceId }: { deviceId: number }) => (
    <div data-testid="settings-surface">settings for {deviceId}</div>
  ),
}))

import { DetectionPipelineTab } from '../DetectionPipelineTab'

describe('DetectionPipelineTab', () => {
  it('renders both Steps and Settings sub-tab triggers', () => {
    render(<DetectionPipelineTab deviceId={7} />)
    expect(screen.getByRole('tab', { name: 'Steps' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy()
  })

  it('defaults to the Steps sub-tab when no sub id is supplied', () => {
    render(<DetectionPipelineTab deviceId={7} />)
    expect(screen.getByTestId('steps-surface').textContent).toContain('steps for 7')
    expect(screen.queryByTestId('settings-surface')).toBeNull()
  })

  it('shows the Settings surface when activeSubTab is "settings"', () => {
    render(<DetectionPipelineTab deviceId={9} activeSubTab="settings" />)
    expect(screen.getByTestId('settings-surface').textContent).toContain('settings for 9')
    expect(screen.queryByTestId('steps-surface')).toBeNull()
  })

  it('falls back to Steps for an unknown sub id', () => {
    render(<DetectionPipelineTab deviceId={1} activeSubTab="bogus" />)
    expect(screen.getByTestId('steps-surface')).toBeTruthy()
    expect(screen.queryByTestId('settings-surface')).toBeNull()
  })

  it('emits the sub-tab id through onSubTabChange when a trigger is clicked', () => {
    const onSubTabChange = vi.fn()
    render(<DetectionPipelineTab deviceId={3} onSubTabChange={onSubTabChange} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(onSubTabChange).toHaveBeenCalledWith('settings')
  })
})
