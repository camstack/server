/**
 * The cluster palette editor refuses a table the hub would refuse (D939).
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { DISPLAY_PRESETS } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { PaletteEditor } from '../palette-editor'

function camstack() {
  const row = DISPLAY_PRESETS.find((preset) => preset.id === 'camstack')
  if (row === undefined) throw new Error('CamStack preset missing')
  return row
}

describe('PaletteEditor', () => {
  it('shows the bundled preset as valid', () => {
    const row = camstack()
    render(
      <PaletteEditor
        status="ready"
        source="unconfigured"
        presetId={row.id}
        swatches={row.swatches}
        presets={DISPLAY_PRESETS}
        onApply={vi.fn()}
      />,
    )
    expect(screen.getByText('CamStack preset (cluster default)')).toBeInTheDocument()
    expect(screen.getByTestId('palette-verdict')).toHaveTextContent(
      'Every colour is distinct on both themes.',
    )
    expect(screen.getByTestId('palette-preview')).toBeInTheDocument()
    expect(screen.getAllByText('Live cursor').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Heatmap handle').length).toBeGreaterThan(0)
    expect(screen.getAllByText(row.swatches.live?.hex ?? '').length).toBeGreaterThan(0)
    expect(screen.getAllByText(row.swatches.heatmapScrub?.hex ?? '').length).toBeGreaterThan(0)
    const vehicle = screen.getByTestId('palette-subs-dark-vehicle')
    expect(vehicle).not.toHaveAttribute('open')
    const summary = vehicle.querySelector('summary')
    if (summary === null) throw new Error('vehicle subclasses missing')
    fireEvent.click(summary)
    expect(vehicle).toHaveAttribute('open')
    expect(screen.getAllByText('Car').length).toBeGreaterThan(0)
  })

  it('names the pair when a custom colour collides', () => {
    const row = camstack()
    const vehicle = row.swatches.vehicle?.hex
    if (vehicle === undefined) throw new Error('vehicle swatch missing')
    render(
      <PaletteEditor
        status="ready"
        source="stored"
        presetId={row.id}
        swatches={row.swatches}
        presets={DISPLAY_PRESETS}
        onApply={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    const person = row.swatches.person?.hex
    if (person === undefined) throw new Error('person swatch missing')
    const field = screen
      .getAllByDisplayValue(person)
      .find((el) => el.getAttribute('type') === 'text')
    if (field === undefined) throw new Error('person colour field missing')
    fireEvent.change(field, { target: { value: vehicle } })
    const verdict = screen.getByTestId('palette-verdict')
    expect(verdict.textContent).toContain('person')
    expect(verdict.textContent).toContain('vehicle')
  })

  it('says the store is unknown instead of calling it the default', () => {
    render(
      <PaletteEditor
        status="unknown"
        reason="stored palette is unreadable"
        presets={DISPLAY_PRESETS}
        onApply={vi.fn()}
      />,
    )
    expect(screen.getByTestId('palette-unknown').textContent).toContain(
      'stored palette is unreadable',
    )
    expect(screen.getByTestId('palette-unknown').textContent).toContain('bundled CamStack preset')
  })
})
