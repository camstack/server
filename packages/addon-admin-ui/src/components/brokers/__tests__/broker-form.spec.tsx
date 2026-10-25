/**
 * BrokerForm — kind-driven broker settings form.
 *
 * Verifies the form renders fields from `broker.getSettingsSchema(kind)`
 * (no kind-specific branching) and that submit prunes hidden `showWhen`
 * fields so a deselected branch's stale values never leak into the
 * emitted settings (the `settingsToAuth` field-presence validator
 * depends on this).
 *
 * Partial-mock of `@camstack/ui-library`: only the broker hooks are
 * stubbed; `ConfigFormField` / `isFieldVisible` (consumed by FormBuilder)
 * keep their real implementations.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockTestSettings = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useBrokerGetSettingsSchema: () => ({
      data: {
        sections: [
          {
            id: 'conn',
            title: 'Conn',
            columns: 1,
            fields: [
              {
                type: 'select',
                key: 'authKind',
                label: 'Auth mode',
                options: [
                  { value: 'long-lived', label: 'Long-lived token' },
                  { value: 'supervisor', label: 'Supervisor' },
                ],
                default: 'long-lived',
              },
              {
                type: 'text',
                key: 'baseUrl',
                label: 'HA base URL',
                showWhen: { field: 'authKind', equals: 'long-lived' },
              },
              {
                type: 'password',
                key: 'supervisorToken',
                label: 'Supervisor token',
                showWhen: { field: 'authKind', equals: 'supervisor' },
              },
            ],
          },
        ],
      },
      isLoading: false,
    }),
    useBrokerTestSettings: () => ({ mutateAsync: mockTestSettings, isPending: false }),
  }
})

import { BrokerForm } from '../BrokerForm'

describe('BrokerForm', () => {
  it('renders fields from broker.getSettingsSchema for the given kind', () => {
    render(<BrokerForm kind="home-assistant" onSubmit={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('HA base URL')).toBeTruthy()
  })

  it('submits only currently-visible fields, pruning the deselected showWhen branch', () => {
    const onSubmit = vi.fn()
    render(
      <BrokerForm
        kind="home-assistant"
        initialValues={{
          authKind: 'long-lived',
          baseUrl: 'http://x:8123',
          supervisorToken: 'stale-token',
        }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted).toMatchObject({ authKind: 'long-lived', baseUrl: 'http://x:8123' })
    expect(submitted).not.toHaveProperty('supervisorToken')
  })

  it('disables Save and does not submit when `disabled` is set', () => {
    const onSubmit = vi.fn()
    render(<BrokerForm kind="home-assistant" onSubmit={onSubmit} onCancel={() => {}} disabled />)
    const save = screen.getByRole('button', { name: /save/i })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(save)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
