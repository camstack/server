// @vitest-environment jsdom
/**
 * The role defaults reach the ROW through the context, not through a prop:
 * a `<DeviceItem>` under a `RoleDisplayDefaultsProvider` draws the operator's
 * role icon, and one outside any provider draws the built-in glyph — the same
 * thing it draws while the query has not landed.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'
import { DeviceItem } from '../index'
import type { DeviceItemDevice } from '../helpers'
import { RoleDisplayDefaultsProvider } from '../role-display-defaults-context'

const mockTrpc = {
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

const SIREN: DeviceItemDevice = {
  id: 40,
  stableId: 's-40',
  addonId: 'a',
  type: 'siren',
  name: 'Sirena',
  online: true,
  disabled: false,
  parentDeviceId: 1,
  role: 'siren',
}

/** The lead icon is the first svg in the row; lucide stamps its name on it. */
function leadIconClass(container: HTMLElement): string {
  return container.querySelector('svg')?.getAttribute('class') ?? ''
}

describe('RoleDisplayDefaultsProvider → DeviceItem lead icon', () => {
  it('draws the built-in role glyph outside any provider', () => {
    const { container } = render(<DeviceItem trpc={mockTrpc} device={SIREN} variant="minimal" />)
    expect(leadIconClass(container)).toContain('lucide-siren')
  })

  it('draws the operator role default under a provider', () => {
    const { container } = render(
      <RoleDisplayDefaultsProvider value={{ siren: { icon: 'lock' } }}>
        <DeviceItem trpc={mockTrpc} device={SIREN} variant="minimal" />
      </RoleDisplayDefaultsProvider>,
    )
    expect(leadIconClass(container)).toContain('lucide-lock')
  })
})
