import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WeightSliderStack } from '../placement-board/WeightSliderStack'

const NODES = [
  { id: 'hub', name: 'Hub', weight: 46 },
  { id: 'mac', name: 'Mac', weight: 54 },
]

describe('WeightSliderStack read-only (D750 automatic shares)', () => {
  it('shows the shares but offers no drag and no lock', () => {
    render(<WeightSliderStack nodes={NODES} pending={false} onCommitWeights={vi.fn()} readOnly />)
    for (const slider of screen.getAllByRole('slider')) expect(slider).toBeDisabled()
    expect(screen.queryByRole('button', { name: /lock/i })).toBeNull()
    expect(screen.getByText('46%')).toBeTruthy()
  })

  it('editable by default', () => {
    render(<WeightSliderStack nodes={NODES} pending={false} onCommitWeights={vi.fn()} />)
    for (const slider of screen.getAllByRole('slider')) expect(slider).not.toBeDisabled()
  })
})
