// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues } from '@camstack/types'

/**
 * The system-config bootstrap form: drawn from `getBootstrapForm`, saved through
 * `saveBootstrapForm`; a surface picks its sections; a refused save says why.
 */

const mutateAsync = vi.fn<(input: unknown) => Promise<void>>()
let query: { data?: ConfigUISchemaWithValues; isPending: boolean; isError: boolean } = {
  isPending: false,
  isError: false,
}

vi.mock('../../../hooks/use-bootstrap-form', () => ({
  useBootstrapForm: () => query,
  useSaveBootstrapForm: () => ({ mutateAsync, isPending: false }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}))

import { BootstrapSettingsForm } from '../BootstrapSettingsForm'

const FORM: ConfigUISchemaWithValues = {
  sections: [
    {
      id: 'system-config-server',
      title: 'Server',
      fields: [{ type: 'text', key: 'name', label: 'Server name', value: 'Casa' }],
    },
    {
      id: 'system-config-auth',
      title: 'Authentication',
      fields: [{ type: 'text', key: 'accessTokenExpiry', label: 'Access lifetime', value: '2h' }],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mutateAsync.mockResolvedValue(undefined)
  query = { data: FORM, isPending: false, isError: false }
})
afterEach(() => cleanup())

describe('BootstrapSettingsForm', () => {
  it('draws only the requested sections', () => {
    render(<BootstrapSettingsForm sectionIds={['system-config-auth']} emptyMessage="none" />)
    expect(screen.queryByDisplayValue('Casa')).toBeNull()
    expect(screen.getByDisplayValue('2h')).toBeTruthy()
  })

  it('leaves the omitted sections to the other surface', () => {
    render(<BootstrapSettingsForm omitSectionIds={['system-config-auth']} emptyMessage="none" />)
    expect(screen.getByDisplayValue('Casa')).toBeTruthy()
    expect(screen.queryByDisplayValue('2h')).toBeNull()
  })

  it('saves only the edited key through the save action', async () => {
    render(<BootstrapSettingsForm sectionIds={['system-config-auth']} emptyMessage="none" />)
    fireEvent.change(screen.getByDisplayValue('2h'), { target: { value: '1h' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ patch: { accessTokenExpiry: '1h' } })
  })

  it('shows the hub error of a refused save and keeps the typed value', async () => {
    mutateAsync.mockRejectedValue(new Error('Not a network address or CIDR range: home'))
    render(<BootstrapSettingsForm sectionIds={['system-config-auth']} emptyMessage="none" />)
    fireEvent.change(screen.getByDisplayValue('2h'), { target: { value: 'home' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByText(/Not a network address/)).toBeTruthy()
    await waitFor(() => expect(screen.getByDisplayValue('home')).toBeTruthy())
  })

  it('a failed read says unavailable instead of drawing defaults', () => {
    query = { isPending: false, isError: true }
    render(<BootstrapSettingsForm emptyMessage="Not available" />)
    expect(screen.getByText('Not available')).toBeTruthy()
  })
})
