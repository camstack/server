// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StatusBadge, type StatusBadgeStatus } from '../status-badge'

describe('StatusBadge', () => {
  const defaults: ReadonlyArray<readonly [StatusBadgeStatus, string]> = [
    ['online', 'Online'],
    ['offline', 'Offline'],
    ['running', 'Running'],
    ['stopped', 'Stopped'],
    ['error', 'Error'],
    ['idle', 'Idle'],
    ['enabled', 'Enabled'],
    ['disabled', 'Disabled'],
  ]

  it.each(defaults)('renders the default label of %s', (status, label) => {
    render(<StatusBadge status={status} />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('lets a caller override the label while keeping the status colour', () => {
    const { container } = render(<StatusBadge status="error" label="crashed" />)
    expect(screen.getByText('crashed')).toBeTruthy()
    expect(container.querySelector('.bg-danger')).not.toBeNull()
  })
})
