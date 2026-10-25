import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AddonRowBadge } from '../AddonRowBadge'
import type { BulkUpdateItem } from '@camstack/types'

const baseItem: BulkUpdateItem = {
  name: '@camstack/addon-x',
  isSystem: false,
  fromVersion: '1.0.0',
  toVersion: '1.0.1',
  status: 'queued',
}

describe('AddonRowBadge', () => {
  it.each([
    ['queued', 'queued'],
    ['updating', 'updating'],
    ['done', 'done'],
    ['done-pending-restart', 'pending restart'],
    ['failed', 'failed'],
  ] as const)('renders label "%s" for status %s', (status, expectedLabel) => {
    render(<AddonRowBadge item={{ ...baseItem, status }} />)
    expect(screen.getByText(expectedLabel)).toBeTruthy()
  })

  it('exposes the error message via title attribute when status=failed', () => {
    render(
      <AddonRowBadge item={{ ...baseItem, status: 'failed', error: 'EACCES /etc/hostname' }} />,
    )
    const el = screen.getByText('failed').closest('span')
    expect(el?.getAttribute('title')).toBe('EACCES /etc/hostname')
  })

  it('no title attribute when no error', () => {
    render(<AddonRowBadge item={{ ...baseItem, status: 'done' }} />)
    const el = screen.getByText('done').closest('span')
    expect(el?.getAttribute('title')).toBeNull()
  })
})
