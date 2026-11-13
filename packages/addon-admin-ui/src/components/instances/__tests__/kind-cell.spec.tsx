// @vitest-environment jsdom
/**
 * The Kind cell shows, beside the kind's own icon, a small badge for each instance the row links to
 * (an email target's sender), named on hover. The link is resolved through the instances of its cap.
 * A linked instance whose icon is the row's own icon draws no badge — the main icon names it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StaticAddonIconsProvider } from '../../../contexts/addon-icons-context'
import { KindCell } from '../kind-cell'

const { asked, linked } = vi.hoisted(() => ({
  asked: [] as { functionCap: string; kind?: string }[],
  linked: {
    iconUrl: '/icons/google.svg' as string | undefined,
    addonId: 'google-services',
    name: 'me@example.com',
  },
}))

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
            name: linked.name,
            kind: 'google-account',
            recordKind: 'google-account',
            addonId: linked.addonId,
            ...(linked.iconUrl !== undefined ? { iconUrl: linked.iconUrl } : {}),
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

const tips = (): string[] => screen.getAllByRole('tooltip').map((node) => node.textContent ?? '')

describe('KindCell', () => {
  it('badges a linked instance whose icon differs, and names the send path on hover', () => {
    linked.iconUrl = '/icons/google.svg'
    linked.addonId = 'google-services'
    linked.name = 'me@example.com'
    render(
      <KindCell
        addonId="notifiers"
        providerName="Notifiers"
        label="Email"
        iconUrl="/icons/email.svg"
        links={[{ field: 'sendWith', cap: 'smtp-provider', instanceId: 'acct-1' }]}
      />,
    )
    expect(asked.at(-1)).toEqual({ functionCap: 'smtp-provider' })
    const badge = screen.getByTestId('linked-instance-badge')
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('/icons/google.svg')
    expect(tips()).toEqual(['Email · Notifiers', 'Sends via me@example.com'])
  })

  it('shows no badge for a link that names an instance the cap does not list', () => {
    render(
      <KindCell
        addonId="notifiers"
        providerName="Notifiers"
        label="Email"
        links={[{ field: 'sendWith', cap: 'smtp-provider', instanceId: 'gone' }]}
      />,
    )
    expect(screen.queryByTestId('linked-instance-badge')).toBeNull()
  })

  it('hides the badge when the linked icon is the row icon, and the main icon names that instance', () => {
    linked.iconUrl = '/icons/alexa.svg'
    linked.addonId = 'import-alexa'
    linked.name = 'Home'
    render(
      <KindCell
        addonId="import-alexa"
        providerName="Alexa"
        label="Alexa"
        iconUrl="/icons/alexa.svg"
        links={[{ field: 'brokerId', cap: 'broker', instanceId: 'acct-1' }]}
      />,
    )
    expect(screen.queryByTestId('linked-instance-badge')).toBeNull()
    expect(tips()).toEqual(['Alexa · Alexa · Sends via Home'])
  })

  it('hides the badge when both sides fall back to the same addon icon', () => {
    linked.iconUrl = undefined
    linked.addonId = 'import-alexa'
    linked.name = 'Home'
    render(
      <StaticAddonIconsProvider icons={new Map([['import-alexa', 'assets/icon.svg']])}>
        <KindCell
          addonId="import-alexa"
          providerName="Alexa"
          label="Alexa"
          links={[{ field: 'brokerId', cap: 'broker', instanceId: 'acct-1' }]}
        />
      </StaticAddonIconsProvider>,
    )
    expect(screen.queryByTestId('linked-instance-badge')).toBeNull()
    expect(screen.getByTestId('kind-icon').querySelector('img')?.getAttribute('src')).toBe(
      '/api/addon-assets/import-alexa/assets/icon.svg',
    )
    expect(tips()).toEqual(['Alexa · Alexa · Sends via Home'])
  })
})
