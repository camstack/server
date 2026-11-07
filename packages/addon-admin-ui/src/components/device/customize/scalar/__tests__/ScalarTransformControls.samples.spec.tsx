import type { CustomizeCatalogTransform } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { ScalarTransformControls } from '../ScalarTransformControls'
import type { ScalarTransformDraft } from '../scalar-form'

const DECLARED: readonly CustomizeCatalogTransform[] = [
  {
    kind: 'threshold',
    comparisons: ['gte'],
    comparison: 'gte',
    defaultThreshold: 10,
    defaultStartDwellMs: 100_000,
    defaultStopDwellMs: 480_000,
  },
]

function threshold(minSamples?: number): ScalarTransformDraft {
  return {
    kind: 'threshold',
    comparison: 'gte',
    threshold: 10,
    startDwellMs: 100_000,
    stopDwellMs: 480_000,
    ...(minSamples === undefined ? {} : { minSamples }),
  }
}

function view(value: ScalarTransformDraft, onChange = vi.fn(), defaultSamples?: number) {
  render(
    <ScalarTransformControls
      control="threshold"
      transforms={['threshold']}
      declared={DECLARED}
      unit="W"
      defaultSamples={defaultSamples}
      value={value}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('ScalarTransformControls samples', () => {
  it('shows the decoded samples and compiles an edit into the draft', () => {
    const onChange = view(threshold(2))
    const field = screen.getByLabelText('Samples')
    expect((field as HTMLInputElement).value).toBe('2')
    fireEvent.change(field, { target: { value: '3' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ minSamples: 3 }))
  })

  it('shows the default when the draft carries none, and refuses a non-integer', () => {
    const onChange = view(threshold(), vi.fn(), 2)
    const field = screen.getByLabelText('Samples')
    expect((field as HTMLInputElement).value).toBe('2')
    fireEvent.change(field, { target: { value: '1.5' } })
    fireEvent.change(field, { target: { value: '0' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})
