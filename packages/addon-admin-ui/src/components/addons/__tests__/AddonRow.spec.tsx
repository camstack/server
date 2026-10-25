import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AddonRow } from '../AddonRow'
import type { BulkUpdateItem } from '@camstack/types'

interface MinimalAddon {
  readonly name: string
  readonly currentVersion: string
  readonly isSystem: boolean
  readonly status?: string
}

function row(
  opts: Partial<{
    addon: MinimalAddon
    bulkItem: BulkUpdateItem | null
    disabledByBulk: boolean
    latestVersion: string | null
  }> = {},
) {
  const addon: MinimalAddon = opts.addon ?? {
    name: '@camstack/addon-x',
    currentVersion: '1.0.0',
    isSystem: false,
  }
  return (
    <table>
      <tbody>
        <AddonRow
          addon={addon}
          bulkItem={opts.bulkItem ?? null}
          disabledByBulk={opts.disabledByBulk ?? false}
          latestVersion={opts.latestVersion ?? null}
          onUpdate={vi.fn()}
          onRestart={vi.fn()}
          onUninstall={vi.fn()}
        />
      </tbody>
    </table>
  )
}

describe('AddonRow', () => {
  it('renders addon name and current version', () => {
    render(row({ addon: { name: '@camstack/addon-x', currentVersion: '1.0.0', isSystem: false } }))
    expect(screen.getByText('@camstack/addon-x')).toBeTruthy()
    expect(screen.getByText('1.0.0')).toBeTruthy()
  })

  it('system row: shows SYSTEM badge + Lock icon, no Uninstall button', () => {
    render(row({ addon: { name: '@camstack/types', currentVersion: '0.1.38', isSystem: true } }))
    expect(screen.getByText('SYSTEM')).toBeTruthy()
    // Lock icon — aria-label set on the SVG wrapper
    expect(screen.getByLabelText(/system package/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /uninstall/i })).toBeNull()
  })

  it('non-system row: no SYSTEM badge, Uninstall button present', () => {
    render(row({ addon: { name: '@camstack/addon-x', currentVersion: '1.0.0', isSystem: false } }))
    expect(screen.queryByText('SYSTEM')).toBeNull()
    expect(screen.getByRole('button', { name: /uninstall/i })).toBeTruthy()
  })

  it('disabledByBulk: all action buttons disabled', () => {
    render(
      row({
        addon: { name: '@camstack/addon-x', currentVersion: '1.0.0', isSystem: false },
        latestVersion: '1.0.1',
        disabledByBulk: true,
      }),
    )
    expect((screen.getByRole('button', { name: /update/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: /restart/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: /uninstall/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('renders AddonRowBadge when bulkItem provided', () => {
    const bulkItem: BulkUpdateItem = {
      name: '@camstack/addon-x',
      isSystem: false,
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      status: 'updating',
    }
    render(
      row({
        addon: { name: '@camstack/addon-x', currentVersion: '1.0.0', isSystem: false },
        bulkItem,
      }),
    )
    expect(screen.getByText('updating')).toBeTruthy()
  })

  it('Update button hidden when no update available', () => {
    render(
      row({
        addon: { name: '@camstack/addon-x', currentVersion: '1.0.0', isSystem: false },
        latestVersion: null,
      }),
    )
    expect(screen.queryByRole('button', { name: /^update/i })).toBeNull()
  })

  it('Update button hidden when latest === current', () => {
    render(
      row({
        addon: { name: '@camstack/addon-x', currentVersion: '1.0.1', isSystem: false },
        latestVersion: '1.0.1',
      }),
    )
    expect(screen.queryByRole('button', { name: /^update/i })).toBeNull()
  })

  it('shows a requires-restart indicator for system packages', () => {
    render(
      row({
        addon: { name: '@camstack/system', currentVersion: '1.0.0', isSystem: true },
      }),
    )
    expect(screen.getByText(/requires restart/i)).toBeTruthy()
  })
})
