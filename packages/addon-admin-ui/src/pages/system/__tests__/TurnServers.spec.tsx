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

import { TurnServersPage } from '../TurnServers'

describe('TurnServersPage', () => {
  it('mounts the instances table over turn-provider', () => {
    render(<TurnServersPage />)
    const panel = screen.getByTestId('provider-instances')
    expect(panel.getAttribute('data-cap')).toBe('turn-provider')
    expect(panel.textContent).toBe('TURN Servers')
  })

  it('draws no second list of the ICE servers beside the table', () => {
    const { container } = render(<TurnServersPage />)
    expect(container.querySelectorAll('[data-testid]').length).toBe(1)
  })
})
