/**
 * Training → Providers is one provider-instances list over `training-provider`: a cloud account
 * is a row per record; the page names the function cap and its wording and nothing else.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}))

vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: ({ functionCap, title }: { functionCap: string; title: string }) => (
    <div data-testid="provider-instances" data-cap={functionCap}>
      {title}
    </div>
  ),
}))

import { TrainingProvidersPage } from '../TrainingProviders'

describe('TrainingProvidersPage', () => {
  it('mounts the instances table over training-provider', () => {
    render(<TrainingProvidersPage />)
    expect(screen.getByTestId('provider-instances').getAttribute('data-cap')).toBe(
      'training-provider',
    )
  })

  it('leads back to the Training page on its Providers tab', () => {
    render(<TrainingProvidersPage />)
    fireEvent.click(screen.getByRole('button', { name: /back to training/i }))
    expect(navigate).toHaveBeenCalledWith('/addon/training?tab=providers')
  })
})
