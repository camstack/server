// @vitest-environment jsdom
/**
 * The Kind cell shows, beside the kind's own icon, a small badge for each instance the row links to
 * (an email target's sender), named on hover. The link is resolved through the instances of its cap.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KindCell } from '../kind-cell'

const asked: { functionCap: string; kind?: string }[] = []

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useInstancesOfCap: (filter: { functionCap: string; kind?: string }) => {
      asked.push(filter)
      return {
        data: [
          {
            id: 'acct-1',
            name: 'me@example.com',
            kind: 'google-account',
            recordKind: 'google-account',
            addonId: 'google-services',
            iconUrl: '/icons/google.svg',
            state: 'ok' as const,
            stateLabel: 'Signed in',
            usable: true,
            enabled: true,
            formValues: {},
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      }
    },
  }
})

describe('KindCell', () => {
  it('badges the linked instance with its icon and names it on hover', () => {
    render(
      <KindCell
        addonId="notifiers"
        label="Email"
        iconUrl="/icons/email.svg"
        links={[{ field: 'sendWith', cap: 'smtp-provider', instanceId: 'acct-1' }]}
      />,
    )
    expect(asked.at(-1)).toEqual({ functionCap: 'smtp-provider' })
    const badge = screen.getByTestId('linked-instance-badge')
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('/icons/google.svg')
    expect(screen.getByRole('tooltip').textContent).toBe('me@example.com')
  })

  it('shows no badge for a link that names an instance the cap does not list', () => {
    render(
      <KindCell
        addonId="notifiers"
        label="Email"
        links={[{ field: 'sendWith', cap: 'smtp-provider', instanceId: 'gone' }]}
      />,
    )
    expect(screen.queryByTestId('linked-instance-badge')).toBeNull()
  })
})
