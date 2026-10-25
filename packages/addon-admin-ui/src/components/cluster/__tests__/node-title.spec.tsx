// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

let info: { name: string; isDefault: boolean } | null = null
vi.mock('../../../hooks/use-server-name', () => ({
  useServerName: () => ({ info, isLoading: false }),
}))

import { NodeTitle } from '../NodeTitle'

afterEach(() => cleanup())

describe('NodeTitle (D861)', () => {
  it('the hub row leads with the server name and keeps the node id as the secondary label', () => {
    info = { name: 'Casa Napoli', isDefault: false }
    render(<NodeTitle node={{ id: 'hub', name: 'hub', isHub: true }} />)
    expect(screen.getByTestId('node-title-name').textContent).toBe('Casa Napoli')
    expect(screen.getByTestId('node-title-id').textContent).toBe('hub')
  })

  it('an agent row is untouched', () => {
    info = { name: 'Casa Napoli', isDefault: false }
    render(<NodeTitle node={{ id: 'garage-nuc', name: 'garage-nuc', isHub: false }} />)
    expect(screen.getByText('garage-nuc')).toBeTruthy()
    expect(screen.queryByTestId('node-title-id')).toBeNull()
  })

  it('before the hub answers, the hub row is its node name', () => {
    info = null
    render(<NodeTitle node={{ id: 'hub', name: 'hub', isHub: true }} />)
    expect(screen.getByText('hub')).toBeTruthy()
    expect(screen.queryByTestId('node-title-name')).toBeNull()
  })
})
