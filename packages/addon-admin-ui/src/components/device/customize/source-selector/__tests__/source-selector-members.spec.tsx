/**
 * The helper member picker lists only what the template accepts — the
 * catalog's `memberDeviceTypes` and `accept` caps. An incompatible device is
 * not rendered at all (not greyed out, not folded into a "not compatible" list).
 */
import { groupTemplate, sourcePickForTemplate } from '@camstack/types'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { SourceSelectorMembers } from '../SourceSelectorMembers'

vi.mock('../../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: { listAll: { query: () => new Promise(() => undefined) } },
      addons: { list: { query: () => new Promise(() => undefined) } },
      integrations: { list: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

function fleetRow(id: number, name: string, type: string) {
  return {
    id,
    name,
    addonId: 'provider-homeassistant',
    stableId: `sensor.${id}`,
    location: 'Porch',
    type,
    parentDeviceId: null,
  }
}

const fleet = [
  fleetRow(1, 'Porch sensor', 'sensor'),
  fleetRow(2, 'Porch light', 'light'),
  fleetRow(3, 'Porch camera', 'camera'),
]

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceManagerListAll: () => ({ status: 'success', data: fleet }),
  useDeviceManagerGetWireableFields: () => ({ status: 'pending' }),
  useDeviceStateGetSnapshot: () => ({ status: 'pending' }),
}))

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known',
    value: new Map([
      [1, ['temperature-sensor']],
      [2, ['temperature-sensor']],
      [3, []],
    ]),
  }),
}))

function renderMembers(): void {
  const template = groupTemplate('temperature')
  if (template === null) throw new Error('missing template')
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SourceSelectorMembers
        kind="members"
        request={sourcePickForTemplate(template)}
        enabled
        members={[]}
        onMembersChange={() => undefined}
        onRefuse={() => undefined}
      />
    </QueryClientProvider>,
  )
}

describe('SourceSelectorMembers', () => {
  it('renders a compatible device and leaves an incompatible one out entirely', () => {
    renderMembers()
    expect(screen.getByRole('checkbox', { name: /Porch sensor/ })).toBeTruthy()
    expect(screen.queryByText(/Porch light/)).toBeNull()
    expect(screen.queryByText(/Porch camera/)).toBeNull()
    expect(screen.queryByTestId('helper-incompatible-devices')).toBeNull()
  })
})
