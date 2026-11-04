import type { TrainingProviderDescriptor } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderAccountsPanel, TRAINING_PROVIDERS_PATH } from '../ProviderAccountsPanel.js'

function descriptor(
  entryId: string,
  name: string,
  configured: boolean,
): TrainingProviderDescriptor {
  return {
    addonId: 'training-modal',
    entryId,
    typeId: 'modal',
    name,
    iconAsset: 'assets/training-modal/icon.svg',
    kind: 'modal',
    label: 'Modal',
    gpuTypes: [],
    regions: [],
    maxDatasetBytes: 1,
    maxRuntimeSec: 1,
    dataResidencyNote: 'note',
    configured,
    defaults: {
      gpuType: 'L4',
      region: '',
      costCapUsd: 5,
      maxRuntimeSec: 14400,
      failedDatasetGraceHours: 24,
    },
  }
}

describe('ProviderAccountsPanel', () => {
  it('lists every account with its state and never the credentials', () => {
    render(
      <ProviderAccountsPanel
        navigate={vi.fn()}
        providers={[descriptor('a', 'Home account', true), descriptor('b', 'Lab', false)]}
      />,
    )
    expect(screen.getByText(/Home account/)).toBeTruthy()
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
  })

  it('leads to the admin instances table', () => {
    const navigate = vi.fn()
    render(
      <ProviderAccountsPanel navigate={navigate} providers={[descriptor('a', 'Home', true)]} />,
    )
    fireEvent.click(screen.getByTestId('training-providers-manage'))
    expect(navigate).toHaveBeenCalledWith(TRAINING_PROVIDERS_PATH)
  })

  it('an answered empty list says so; an unanswered one never claims "no accounts"', () => {
    const { rerender } = render(<ProviderAccountsPanel navigate={vi.fn()} providers={[]} />)
    expect(screen.getByText('No training accounts yet')).toBeTruthy()
    rerender(<ProviderAccountsPanel navigate={vi.fn()} providers={null} />)
    expect(screen.queryByText('No training accounts yet')).toBeNull()
  })
})
