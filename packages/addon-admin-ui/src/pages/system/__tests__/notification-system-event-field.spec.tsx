/**
 * D637 — the system-event field authors ONE family.
 *
 * What an operator pays for when it breaks: a device picker on a rule about
 * nodes (a filter the hub refuses), a last kind unticked (the rule flips to
 * `mixed` mid-edit), a node list read from `nodes.topology` (32–51 s, D315),
 * and a mixed rule rewritten by merely opening it.
 */
import type { NcConditionDescriptor, NcSystemEventCondition, NodeDirectory } from '@camstack/types'
import type { System } from '@camstack/sdk'
import { SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDirectory = vi.fn(
  (): Promise<NodeDirectory> =>
    Promise.resolve({
      nodes: [{ id: 'hub', name: 'Hub', isHub: true, isOnline: true }],
      complete: true,
    }),
)
const mockTopology = vi.fn(() => Promise.resolve([]))
const mockListPackages = vi.fn(() =>
  Promise.resolve([{ name: '@camstack/addon-ai', version: '0.2.17' }]),
)
/** The D642 schema probe (`previewTemplate`) — a current hub renders it. */
const mockPreview = vi.fn(
  (): Promise<unknown> => Promise.resolve({ title: null, body: 'x', unknown: [] }),
)

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        nodes: {
          directory: { query: mockDirectory },
          topology: { query: mockTopology },
        },
        addons: { listPackages: { query: mockListPackages } },
        notificationRules: { previewTemplate: { mutate: mockPreview } },
        deviceManager: { getBindings: { query: () => Promise.resolve({ entries: [] }) } },
      },
    }),
  }
})

import { RuleConditionsEditor } from '../NotificationRuleConditions'
import { ruleScopeDraftOf } from '../rule-scope-model'
import { SystemEventField } from '../notification-system-event-field'
import { NodeScopePicker } from '../scope-pickers'

const FLEET = [
  { id: 1, name: 'Front door', type: 'camera', location: 'Fuori' },
  { id: 3615, name: 'Termometro', type: 'sensor', location: 'Server' },
]

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const system = {
    trpcClient: {
      nodes: {
        directory: { query: mockDirectory },
        topology: { query: mockTopology },
      },
      addons: { listPackages: { query: mockListPackages } },
      notificationRules: { previewTemplate: { mutate: mockPreview } },
      deviceManager: {
        listSiteZones: { query: () => Promise.resolve([]) },
        getBindings: { query: () => Promise.resolve({ entries: [] }) },
      },
    },
  } as unknown as System
  return render(
    <QueryClientProvider client={client}>
      <SystemProvider system={system}>
        <MemoryRouter>{node}</MemoryRouter>
      </SystemProvider>
    </QueryClientProvider>,
  )
}

function renderField(
  family: 'device-events' | 'system' | 'alarm',
  value: NcSystemEventCondition,
  onChange = vi.fn(),
  summary = false,
) {
  wrap(
    <SystemEventField
      family={family}
      value={value}
      cameras={[{ id: 1, name: 'Front door' }]}
      allDevices={FLEET}
      fleet={{ state: 'answered', devices: FLEET }}
      savedHadDevices={false}
      onChange={onChange}
      summary={summary}
    />,
  )
  return onChange
}

const NODE_CLASS = 'Node connectivity (offline / back online)'
const STREAM_CLASS = 'Stream connectivity (offline / back online)'

beforeEach(() => {
  mockDirectory.mockClear()
  mockTopology.mockClear()
  mockListPackages.mockClear()
  mockPreview.mockClear()
})

describe('SystemEventField — one family', () => {
  it('offers only the family’s kinds', () => {
    renderField('system', { kinds: ['node-offline'] })
    expect(screen.getByRole('checkbox', { name: NODE_CLASS })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Backup completed' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Device offline' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Alarm triggered' })).toBeNull()
  })

  it('refuses to untick the last kind — the value handed back is unchanged', () => {
    const value = { kinds: ['node-offline' as const, 'node-online' as const] }
    const onChange = renderField('system', value)
    fireEvent.click(screen.getByRole('checkbox', { name: NODE_CLASS }))
    expect(onChange).toHaveBeenLastCalledWith(value)
  })

  it('D906: one checkbox per paired class, never one per edge', () => {
    renderField('device-events', { kinds: ['device-offline'] })
    expect(screen.getByRole('checkbox', { name: STREAM_CLASS })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Stream offline' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Stream online' })).toBeNull()
    // A one-edge kind stays single.
    expect(
      screen.getByRole('checkbox', { name: 'Motion for 10+ minutes, detector found nothing' }),
    ).toBeTruthy()
  })

  it('D906: ticking a class on an instant rule writes BOTH edges', () => {
    const onChange = renderField('device-events', { kinds: ['device-offline', 'device-online'] })
    fireEvent.click(screen.getByRole('checkbox', { name: STREAM_CLASS }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kinds: expect.arrayContaining(['stream-offline', 'stream-online']),
      }),
    )
  })

  it('D906: on a scheduled summary a class is the bad-state snapshot — bad edges only', () => {
    const onChange = renderField('device-events', { kinds: ['device-offline'] }, vi.fn(), true)
    expect(screen.getByTestId('system-event-class-hint').textContent).toContain(
      'the list of what is in the bad state, not each change',
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Streams offline now' }))
    const next = onChange.mock.lastCall?.[0]
    expect(next?.kinds).toContain('stream-offline')
    expect(next?.kinds).not.toContain('stream-online')
    // A class the summary has no state source for says so instead of faking one.
    expect(
      screen.getByRole('checkbox', {
        name: 'Recordings stalled now — no state snapshot, reports nothing',
      }),
    ).toBeTruthy()
  })

  it('a system rule shows node and package pickers, never a device picker', async () => {
    renderField('system', { kinds: ['addon-updated'] })
    expect(screen.getByTestId('system-event-nodes')).toBeTruthy()
    expect(screen.getByTestId('system-event-packages')).toBeTruthy()
    expect(screen.queryByTestId('system-event-include')).toBeNull()
    expect(screen.queryByTestId('system-event-exclude')).toBeNull()
    await waitFor(() => expect(mockDirectory).toHaveBeenCalled())
    // D315: the node list is the cheap directory, never the cluster walk.
    expect(mockTopology).not.toHaveBeenCalled()
  })

  it('a stored node id the directory lacks stays a removable chip (D49)', async () => {
    const onChange = renderField('system', { kinds: ['node-offline'], nodeIds: ['gone-agent'] })
    const nodes = screen.getByTestId('system-event-nodes')
    await waitFor(() => expect(within(nodes).getByText(/gone-agent/)).toBeTruthy())
    fireEvent.click(within(nodes).getByRole('button', { name: /Remove .*gone-agent/ }))
    expect(onChange).toHaveBeenLastCalledWith({ kinds: ['node-offline'] })
  })

  it('a device-events rule never shows a node picker, and links the cluster thresholds', () => {
    renderField('device-events', { kinds: ['device-battery-low'] })
    expect(screen.queryByTestId('system-event-nodes')).toBeNull()
    const scope = screen.getByTestId('system-event-device-scope')
    expect(within(scope).getByRole('radio', { name: 'All' })).toBeTruthy()
    expect(within(scope).getByRole('radio', { name: 'Only these' })).toBeTruthy()
    expect(within(scope).getByRole('radio', { name: 'All except these' })).toBeTruthy()
    // Empty rule opens on All — no picker until a list mode is chosen.
    expect(screen.queryByTestId('system-event-include')).toBeNull()
    expect(screen.queryByTestId('system-event-exclude')).toBeNull()
    const link = within(screen.getByTestId('system-event-device-alert-settings')).getByRole('link')
    expect(link.getAttribute('href')).toBe('/system/settings')
  })

  it('alarm: the camera filter and the pictures sentence come only with alarm-triggered', () => {
    renderField('alarm', { kinds: ['alarm-armed'] })
    expect(screen.queryByTestId('system-event-device-scope')).toBeNull()
    const settings = screen.getByTestId('system-event-alarm-settings')
    expect(within(settings).getByRole('link').getAttribute('href')).toBe(
      '/system/notifications?tab=alarm',
    )
    expect(settings.textContent).not.toMatch(/pictures/)
  })

  it('alarm with alarm-triggered: camera Only these, no Except, and the pictures sentence', () => {
    renderField('alarm', { kinds: ['alarm-triggered'] })
    const scope = screen.getByTestId('system-event-device-scope')
    expect(within(scope).queryByRole('radio', { name: 'All except these' })).toBeNull()
    fireEvent.click(within(scope).getByRole('radio', { name: 'Only these' }))
    expect(screen.getByTestId('system-event-include')).toBeTruthy()
    expect(screen.queryByTestId('system-event-exclude')).toBeNull()
    expect(screen.getByTestId('system-event-alarm-settings').textContent).toMatch(
      /carries that rule's pictures/,
    )
  })
})

describe('SystemEventField — the consumable threshold (D642)', () => {
  it('shows a number field, defaulting to 15, only with a consumable kind', () => {
    renderField('device-events', { kinds: ['device-consumable-low'] })
    const input = screen.getByTestId('system-event-consumable-threshold')
    expect(input.getAttribute('type')).toBe('number')
    expect(input.getAttribute('placeholder')).toBe('15')
  })

  it('is absent on a battery-only rule', () => {
    renderField('device-events', { kinds: ['device-battery-low'] })
    expect(screen.queryByTestId('system-event-consumable-threshold')).toBeNull()
  })

  it('writes the typed number onto the rule, and an emptied box back to the default', () => {
    const onChange = renderField('device-events', {
      kinds: ['device-consumable-low'],
      consumableLowPercent: 25,
    })
    const input = screen.getByTestId('system-event-consumable-threshold')
    expect((input as HTMLInputElement).value).toBe('25')
    fireEvent.change(input, { target: { value: '10' } })
    expect(onChange).toHaveBeenLastCalledWith({
      kinds: ['device-consumable-low'],
      consumableLowPercent: 10,
    })
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ kinds: ['device-consumable-low'] })
  })

  it('never writes a number the hub would refuse (outside 1–95)', () => {
    const onChange = renderField('device-events', { kinds: ['device-consumable-low'] })
    const input = screen.getByTestId('system-event-consumable-threshold')
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.change(input, { target: { value: '96' } })
    fireEvent.change(input, { target: { value: '150' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

/**
 * D642 review I2: on a hub whose server predates D642 the router strips the
 * threshold and refuses the tank kinds — silently. The field asks the hub
 * (a tank kind in a pure `previewTemplate`) and says so.
 */
describe('SystemEventField — a hub too old for consumable thresholds is SAID', () => {
  it('an old hub (the probe is refused as a bad request): a warning', async () => {
    mockPreview.mockRejectedValueOnce({ data: { code: 'BAD_REQUEST' } })
    renderField('device-events', { kinds: ['device-consumable-low'] })
    await waitFor(() => expect(screen.getByTestId('system-event-hub-outdated')).toBeTruthy())
    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ systemEventKinds: ['device-consumable-low'] }),
      }),
    )
  })

  it('a current hub: no warning', async () => {
    renderField('device-events', { kinds: ['device-consumable-low'] })
    await waitFor(() => expect(mockPreview).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId('system-event-hub-outdated')).toBeNull()
    expect(screen.queryByTestId('system-event-hub-unchecked')).toBeNull()
  })

  it('a probe that failed otherwise says it could not check — never "too old" (D315)', async () => {
    mockPreview.mockRejectedValueOnce(new Error('socket closed'))
    renderField('device-events', { kinds: ['device-consumable-low'] })
    await waitFor(() => expect(screen.getByTestId('system-event-hub-unchecked')).toBeTruthy())
    expect(screen.queryByTestId('system-event-hub-outdated')).toBeNull()
  })

  it('a system or alarm rule does not ask', async () => {
    renderField('system', { kinds: ['node-offline'] })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockPreview).not.toHaveBeenCalled()
  })
})

describe('NodeScopePicker — the incomplete directory is said', () => {
  it('says so under the picker when the directory is not complete', async () => {
    mockDirectory.mockResolvedValueOnce({ nodes: [], complete: false })
    wrap(<NodeScopePicker value={[]} onChange={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('node-directory-incomplete')).toBeTruthy())
  })

  it('says nothing when the directory is complete', async () => {
    wrap(<NodeScopePicker value={[]} onChange={() => {}} />)
    await waitFor(() => expect(mockDirectory).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Loading nodes/)).toBeNull())
    expect(screen.queryByTestId('node-directory-incomplete')).toBeNull()
  })
})

describe('RuleConditionsEditor — a mixed system rule is never rewritten', () => {
  const SYSTEM: NcConditionDescriptor = {
    id: 'systemEvent',
    group: 'scope',
    label: 'Events',
    valueType: 'systemEvent',
    operator: 'in',
    appliesTo: ['system-event'],
    phase: 'P1',
  }

  function renderEditor(conditions: { systemEvent?: NcSystemEventCondition }) {
    const changes: unknown[] = []
    wrap(
      <RuleConditionsEditor
        classScope={ruleScopeDraftOf<string>(undefined, undefined)}
        onClassScopeChange={() => {}}
        catalog={[SYSTEM]}
        taxonomy={undefined}
        delivery="system-event"
        conditions={conditions}
        savedConditions={conditions}
        schedule={undefined}
        deviceIds={[]}
        cameras={[]}
        fleet={{ state: 'answered', devices: [] }}
        gateable={[]}
        gateableScenes={[]}
        onConditionsChange={(next) => changes.push(next)}
        onScheduleChange={() => {}}
      />,
    )
    return changes
  }

  it('renders the kinds read-only, with no control that writes', () => {
    const changes = renderEditor({ systemEvent: { kinds: ['device-offline', 'node-offline'] } })
    const note = screen.getByTestId('system-event-mixed')
    expect(note.textContent).toContain('Device offline, Node offline')
    expect(screen.queryByTestId('system-event-field')).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(changes).toEqual([])
  })

  it('a family rule gets the family field', () => {
    renderEditor({ systemEvent: { kinds: ['alarm-armed'] } })
    expect(screen.getByTestId('system-event-field')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Alarm armed' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Node offline' })).toBeNull()
  })
})
