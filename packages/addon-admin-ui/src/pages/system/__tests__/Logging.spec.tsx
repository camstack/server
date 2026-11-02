/**
 * Logs → Destinations is one provider-instances list over `log-destination`; the page names the
 * function cap and its wording and nothing else.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../components/integration-hub/provider-instances/ProviderInstancesPanel', () => ({
  ProviderInstancesPanel: ({ functionCap, title }: { functionCap: string; title: string }) => (
    <div data-testid="provider-instances" data-cap={functionCap}>
      {title}
    </div>
  ),
}))

import { LoggingPage } from '../Logging'

describe('LoggingPage', () => {
  it('mounts the provider-instances panel over log-destination', () => {
    render(<LoggingPage />)
    const panel = screen.getByTestId('provider-instances')
    expect(panel.getAttribute('data-cap')).toBe('log-destination')
    expect(panel.textContent).toBe('Destinations')
  })
})
