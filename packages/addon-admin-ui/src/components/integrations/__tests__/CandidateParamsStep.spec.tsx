/**
 * The parameters step tells pending, "no creation type" and failed apart: a
 * provider that answers `deviceType: null` (schema query disabled) used to
 * spin forever, and a failed query looked like loading.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const q = vi.hoisted(() => ({
  type: {} as Record<string, unknown>,
  schema: {} as Record<string, unknown>,
}))

vi.mock('@camstack/ui-library', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useDeviceManagerProviderCreationType: () => q.type,
  useDeviceManagerGetCreationSchema: () => q.schema,
}))
vi.mock('../../form-builder/FormBuilder', () => ({ FormBuilder: () => <div>form</div> }))

import { CandidateParamsStep } from '../NetworkCandidatesPanel'

const row = {
  key: 'k',
  name: 'Cam',
  address: null,
  sources: [],
  hit: null,
  adoptionId: null,
  proposalId: null,
  alreadyAdded: false,
  addedName: null,
  needsParams: [],
  parentKey: null,
} as never

function renderStep(onBack = vi.fn()) {
  return render(
    <CandidateParamsStep
      addonId="a"
      integrationId="i"
      row={row}
      found={{}}
      busy={false}
      error={null}
      onBack={onBack}
      onSubmit={vi.fn()}
      embedded
    />,
  )
}
const addButton = () => screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement

describe('CandidateParamsStep states', () => {
  beforeEach(() => {
    q.type = { isSuccess: false, data: undefined, error: null }
    q.schema = { data: undefined, error: null }
  })

  it('pending: spinner, Add disabled', () => {
    const { container } = renderStep()
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(addButton().disabled).toBe(true)
  })

  it('answered with no creation type: a clear line, no spinner, Back works', () => {
    q.type = { isSuccess: true, data: { deviceType: null }, error: null }
    const onBack = vi.fn()
    const { container } = renderStep(onBack)
    expect(screen.getByText(/cannot create a device from this candidate/)).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(addButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Back to the list/ }))
    expect(onBack).toHaveBeenCalled()
  })

  it('error: the query message, no spinner, Add disabled', () => {
    q.type = { isSuccess: false, data: undefined, error: new Error('type boom') }
    const { container } = renderStep()
    expect(screen.getByText('type boom')).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(addButton().disabled).toBe(true)
  })
})
