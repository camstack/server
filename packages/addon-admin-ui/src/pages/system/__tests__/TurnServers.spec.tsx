/**
 * Network → TURN Servers is one provider-instances list over `turn-provider`: the static servers
 * (a row per record) and Cloudflare TURN (one account) are rows of the same panel; the page names
 * the function cap and its wording and nothing else.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: ({ functionCap, title }: { functionCap: string; title: string }) => (
    <div data-testid="provider-instances" data-cap={functionCap}>
      {title}
    </div>
  ),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useTurnProviderGetTurnServers: () => ({
    data: [{ urls: ['turn:203.0.113.7:3478'], username: 'u', credential: 'SECRET' }],
    refetch: vi.fn(),
    isFetching: false,
  }),
}))

import { TurnServersPage } from '../TurnServers'

describe('TurnServersPage', () => {
  it('mounts the instances table over turn-provider', () => {
    render(<TurnServersPage />)
    const panel = screen.getByTestId('provider-instances')
    expect(panel.getAttribute('data-cap')).toBe('turn-provider')
    expect(panel.textContent).toBe('TURN Servers')
  })

  it('keeps the combined ICE list below the panel, never showing the credential', () => {
    const { container } = render(<TurnServersPage />)
    expect(screen.getByText('turn:203.0.113.7:3478')).toBeTruthy()
    expect(container.textContent).not.toContain('SECRET')
  })
})
