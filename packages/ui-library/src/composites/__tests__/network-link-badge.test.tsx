import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NetworkLinkBadge } from '../network-link-badge'

describe('NetworkLinkBadge', () => {
  it('renders nothing for an unknown link — not read yet is not a link', () => {
    const { container } = render(<NetworkLinkBadge status={{ type: 'unknown', signal: null }} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the signal for a wireless link', () => {
    const { getByTitle } = render(
      <NetworkLinkBadge status={{ type: 'wifi', signal: 75, ssid: 'casa' }} />,
    )
    expect(getByTitle('Network: wifi (casa) · signal 75%').textContent).toBe('75%')
  })

  it('shows no percentage for a wire — it has no signal', () => {
    const { getByTitle } = render(<NetworkLinkBadge status={{ type: 'ethernet', signal: null }} />)
    expect(getByTitle('Network: ethernet').textContent).toBe('')
  })

  it('shows no percentage for a wireless link whose signal is not known yet', () => {
    const { getByTitle } = render(<NetworkLinkBadge status={{ type: 'wifi', signal: null }} />)
    expect(getByTitle('Network: wifi').textContent).toBe('')
  })
})
