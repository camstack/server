// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PipelineAddonSchema } from '@camstack/types'
import { GateControl } from '../gate-control'
import { SegmentedChoice } from '../segmented-choice'
import { dockBox } from '../step-detail-dock'
import { searchSteps } from '../step-search'
import { StepInspectorPanel } from '../step-inspector-panel'
import { StepModelRow } from '../step-model-row'

afterEach(cleanup)

describe('SegmentedChoice', () => {
  it('a disabled option cannot be picked and says why on hover', () => {
    const onChange = vi.fn<(next: string) => void>()
    render(
      <SegmentedChoice
        label="Root detector"
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true, reason: 'Not on this camera' },
        ]}
      />,
    )
    const b = screen.getByRole('radio', { name: 'B' })
    expect((b as HTMLButtonElement).disabled).toBe(true)
    expect(b.getAttribute('title')).toBe('Not on this camera')
    fireEvent.click(b)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'A' }))
    expect(onChange).toHaveBeenCalledWith('a')
  })
})

describe('GateControl', () => {
  it('is a labelled radio group; Auto inherits, On/Off pin', () => {
    const onSet = vi.fn<(next: boolean | null) => void>()
    render(
      <GateControl
        gate={{ kind: 'gate', effectiveOn: true, defaultOn: true, explicit: false }}
        onSet={onSet}
      />,
    )
    const group = screen.getByRole('radiogroup', { name: /runs on this camera/i })
    const auto = within(group).getByRole('radio', { name: /auto/i })
    expect(auto.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }))
    expect(onSet).toHaveBeenLastCalledWith(false)
    fireEvent.click(auto)
    expect(onSet).toHaveBeenLastCalledWith(null)
    expect(screen.getByText(/default: on/i)).toBeTruthy()
  })

  it('segments are at least 36 px tall on a phone (no 26 px targets)', () => {
    render(
      <GateControl
        gate={{ kind: 'gate', effectiveOn: false, defaultOn: false, explicit: true }}
        onSet={() => {}}
      />,
    )
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.className).toMatch(/\bh-9\b/)
    }
  })

  it('a zone-driven step shows a badge, not a switch', () => {
    render(<GateControl gate={{ kind: 'zone-driven' }} onSet={() => {}} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.getByText(/zones/i)).toBeTruthy()
  })
})

const ADDON: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: [],
  childSlots: [],
  models: [
    { id: 'm-a', name: 'Model A', formats: { openvino: { downloaded: true, sizeMB: 1 } } },
    { id: 'm-b', name: 'Model B', formats: { openvino: { downloaded: true, sizeMB: 1 } } },
  ],
  defaultModelId: 'm-a',
  defaultConfidence: 0.5,
}

describe('StepModelRow', () => {
  it('shows the model + its source; Change opens the picker; reset only when this layer pins', () => {
    const onReset = vi.fn()
    const onToggle = vi.fn()
    const { rerender } = render(
      <StepModelRow
        label="hub · NPU"
        format="openvino"
        modelId="m-a"
        source="node"
        sourceLabel="node default"
        models={ADDON.models}
        expanded={false}
        onToggle={onToggle}
        onChangeModel={() => {}}
      />,
    )
    expect(screen.getByText('m-a')).toBeTruthy()
    expect(screen.getByText('node default')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /change model for hub · NPU/i }))
    expect(onToggle).toHaveBeenCalled()

    rerender(
      <StepModelRow
        label="hub · NPU"
        format="openvino"
        modelId="m-b"
        source="camera"
        sourceLabel="this camera"
        models={ADDON.models}
        expanded
        onToggle={onToggle}
        onChangeModel={() => {}}
        onReset={onReset}
        resetLabel="Reset to node default"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset to node default' }))
    expect(onReset).toHaveBeenCalled()
  })
})

describe('StepInspectorPanel', () => {
  it('pins header and save bar around ONE scrolling body; Escape asks to leave', () => {
    const onEscape = vi.fn()
    const onSave = vi.fn()
    render(
      <StepInspectorPanel
        title="Object Detection"
        subtitle="detector"
        onEscape={onEscape}
        saveBar={{ dirtyCount: 2, saving: false, status: null, onSave, onDiscard: () => {} }}
      >
        <p>body</p>
      </StepInspectorPanel>,
    )
    const region = screen.getByRole('region', { name: 'Object Detection' })
    expect(region.querySelectorAll('[data-inspector-body]')).toHaveLength(1)
    expect(screen.getByText(/2 unsaved changes/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalled()
    fireEvent.keyDown(region, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalled()
  })

  it('a clean form disables Save and says nothing is pending', () => {
    render(
      <StepInspectorPanel
        title="T"
        saveBar={{
          dirtyCount: 0,
          saving: false,
          status: 'saved',
          onSave: () => {},
          onDiscard: () => {},
        }}
      >
        <p>body</p>
      </StepInspectorPanel>,
    )
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/saved/i)).toBeTruthy()
  })

  it('draws the scope of a save on its own row, beside Save', () => {
    render(
      <StepInspectorPanel
        title="T"
        saveBar={{
          dirtyCount: 1,
          saving: false,
          status: null,
          onSave: () => {},
          onDiscard: () => {},
          scope: <span>Applies to: this accelerator</span>,
        }}
      >
        <p>body</p>
      </StepInspectorPanel>,
    )
    const footer = screen.getByRole('button', { name: 'Save' }).closest('footer')
    expect(footer?.querySelector('[data-save-scope]')?.textContent).toBe(
      'Applies to: this accelerator',
    )
  })
})

describe('dockBox', () => {
  it('sits over the right edge of its scroll container, its own height', () => {
    expect(
      dockBox({
        scroller: { top: 96, bottom: 900, right: 1440 },
        viewportWidth: 1440,
        widthPx: 432,
      }),
    ).toEqual({ top: 96, height: 804, right: 0, width: 432 })
    // A container that ends before the viewport's edge (a side column).
    expect(
      dockBox({
        scroller: { top: 56, bottom: 700, right: 1200 },
        viewportWidth: 1280,
        widthPx: 432,
      }),
    ).toEqual({ top: 56, height: 644, right: 80, width: 432 })
  })
})

describe('searchSteps', () => {
  const rows = [
    {
      addonId: 'object-detection',
      name: 'Object Detection',
      fieldLabels: ['Min Confidence — Person'],
    },
    {
      addonId: 'face-embedding',
      name: 'Face Embedding',
      fieldLabels: ['Min face size for recognition'],
    },
  ]
  it('matches a name, or a field label and says which', () => {
    expect(searchSteps(rows, 'face size')).toEqual([
      { addonId: 'face-embedding', matchedField: 'Min face size for recognition' },
    ])
    expect(searchSteps(rows, 'object')).toEqual([{ addonId: 'object-detection' }])
    expect(searchSteps(rows, '  ')).toHaveLength(2)
  })
})
