/**
 * The helper member picker lists only what the template accepts — the
 * catalog's `memberDeviceTypes` and `accept` caps. An incompatible device is
 * not rendered at all (not greyed out, not folded into a "not compatible" list).
 */
import { groupTemplate, sourcePickForTemplate } from '@camstack/types'
import type { HelperMember } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { SourceSelectorMembers } from '../SourceSelectorMembers'

vi.mock('../../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      deviceManager: {
        listAll: { query: () => new Promise(() => undefined) },
      },
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
  fleetRow(4, 'Garden sensor', 'sensor'),
]

const template = groupTemplate('temperature')
if (template === null) throw new Error('missing template')
const pickRequest = sourcePickForTemplate(template)

const wireableByDevice = new Map<number, unknown>()

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceManagerListAll: () => ({ status: 'success', data: fleet }),
  useDeviceManagerGetWireableFields: (input: { deviceId: number }) =>
    wireableByDevice.has(input.deviceId)
      ? { status: 'success', data: wireableByDevice.get(input.deviceId) }
      : { status: 'pending' },
  useDeviceStateGetSnapshot: (input: { deviceId: number }) =>
    wireableByDevice.has(input.deviceId)
      ? {
          status: 'success',
          data: { 'temperature-sensor': { temperature: input.deviceId * 10 } },
        }
      : { status: 'pending' },
}))

vi.mock('../../assignments/use-cap-index', () => ({
  useCapIndex: () => ({
    kind: 'known',
    value: new Map([
      [1, ['temperature-sensor']],
      [2, ['temperature-sensor']],
      [3, []],
      [4, ['temperature-sensor', 'climate-control']],
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

  it('lists the fields of every selected device and scopes each radio group to its device', () => {
    const [first, second] = pickRequest.accept
    if (first === undefined || second === undefined) throw new Error('template needs two accepts')
    const catalogFor = (extra: boolean) => ({
      caps: [
        {
          cap: first.cap,
          fields: [{ path: first.fieldPath, kind: first.valueKind }],
        },
        ...(extra
          ? [
              {
                cap: second.cap,
                fields: [{ path: second.fieldPath, kind: second.valueKind }],
              },
            ]
          : []),
      ],
    })
    wireableByDevice.set(1, catalogFor(false))
    wireableByDevice.set(4, catalogFor(true))
    const seen: { current: readonly HelperMember[] } = { current: [] }
    function Harness(): React.ReactNode {
      const [members, setMembers] = useState<readonly HelperMember[]>([])
      seen.current = members
      return (
        <QueryClientProvider client={new QueryClient()}>
          <SourceSelectorMembers
            kind="members"
            request={pickRequest}
            enabled
            members={members}
            onMembersChange={setMembers}
            onRefuse={() => undefined}
          />
        </QueryClientProvider>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Porch sensor/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Garden sensor/ }))
    const one = within(screen.getByTestId('helper-member-section-1'))
    const four = within(screen.getByTestId('helper-member-section-4'))
    expect(one.getAllByRole('radio')).toHaveLength(1)
    expect(four.getAllByRole('radio')).toHaveLength(2)
    expect(
      four.getAllByRole('radio').every((r) => r.getAttribute('name') === 'helper-member-value-4'),
    ).toBe(true)
    expect(one.getByRole('radio').getAttribute('name')).toBe('helper-member-value-1')
    const before = seen.current.find((m) => m.source.stableId === 'sensor.1')
    fireEvent.click(four.getByTestId(`helper-value-4-${second.cap}.${second.fieldPath}`))
    const afterOne = seen.current.find((m) => m.source.stableId === 'sensor.1')
    const afterFour = seen.current.find((m) => m.source.stableId === 'sensor.4')
    expect(afterOne).toEqual(before)
    expect(afterOne?.cap).toBe(first.cap)
    expect(afterFour?.cap).toBe(second.cap)
  })
})
