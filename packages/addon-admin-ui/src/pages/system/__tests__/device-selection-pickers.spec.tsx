/**
 * Every notification device picker, mounted with a selected device the hub no
 * longer has.
 *
 * Operator report 2026-09-25: a rule kept a deleted device, no picker drew it,
 * and when it was the ONLY one the editor read "Every device" while the rule
 * matched nothing. Asserted per picker, because each draws its own list:
 *  - an ANSWERED list without the id draws the chip "Device #<id> — removed",
 *    and removing it takes it out of the value — never on a read (D49);
 *  - a PENDING list is a loading line, never the "applies to all" hint, and a
 *    FAILED one still lists every selected id by number (D315);
 *  - emptying an all-meaning selection that held devices says it widens.
 */
import type {
  NcAlarmModeCoverage,
  NcAlarmSettings,
  NcConditionDescriptor,
  NcConditions,
  NcSystemEventCondition,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { SystemProvider } from '@camstack/ui-library'
import type { System } from '@camstack/sdk'
import { AlarmModeCard } from '../alarm-mode-card'
import { alarmDeviceNames } from '../alarm-nonblocking.helpers'
import { alarmSensorRows } from '../alarm-sensor-table-model'
import type { DeviceListState } from '../device-selection'
import { NotificationRuleActions } from '../NotificationRuleActions'
import { RuleConditionsEditor } from '../NotificationRuleConditions'
import { NotificationRuleDevices } from '../NotificationRuleDevices'
import { DeviceListField } from '../notification-condition-widgets'
import { DigestCameraField } from '../notification-digest-fields'
import type { NcRuleActionsFormState } from '../notification-rule-actions'
import { SystemEventField } from '../notification-system-event-field'
import { ruleScopeDraftOf } from '../rule-scope-model'

const CAMERAS = [
  { id: 1, name: 'Front door' },
  { id: 5, name: 'Garden' },
]
const APPLIES_TO_ALL = 'No cameras available — the rule applies to all devices.'
const REMOVED_42 = 'Device #42 — removed'

type PickerKind = 'conditions' | 'devicesTab' | 'digest'

interface HarnessProps {
  readonly kind: PickerKind
  readonly initial: readonly number[]
  readonly listState: DeviceListState
  readonly cameras: readonly { readonly id: number; readonly name: string }[]
  /** Fleet devices that are NOT cameras — judged, never drawn, by a camera picker. */
  readonly others: readonly { readonly id: number; readonly name: string }[]
  readonly savedHadDevices: boolean
  readonly seen: (next: readonly number[]) => void
}

/** Owns the value the way each editor does, so a deselect re-renders. */
function Harness({
  kind,
  initial,
  listState,
  cameras,
  others,
  savedHadDevices,
  seen,
}: HarnessProps) {
  const [value, setValue] = useState<readonly number[]>(initial)
  const fleet = {
    state: listState,
    devices: listState === 'answered' ? [...cameras, ...others] : undefined,
  }
  const onChange = (next: number[]): void => {
    seen(next)
    setValue(next)
  }
  if (kind === 'conditions') {
    return (
      <DeviceListField
        cameras={cameras}
        fleet={fleet}
        value={value}
        onChange={onChange}
        emptyMeansAll
        savedHadDevices={savedHadDevices}
      />
    )
  }
  if (kind === 'digest') {
    return <DigestCameraField cameras={cameras} fleet={fleet} value={value} onChange={onChange} />
  }
  return (
    <NotificationRuleDevices
      devices={cameras.map((c) => ({ ...c, type: 'camera', location: null }))}
      listState={listState}
      savedHadDevices={savedHadDevices}
      value={value}
      onChange={onChange}
    />
  )
}

/** Minimal System for DevicePicker's site-zones query (D636 open list). */
function mockSystem(): System {
  return {
    trpcClient: {
      deviceManager: {
        listSiteZones: { query: () => Promise.resolve([]) },
        getBindings: { query: () => Promise.resolve({ entries: [] }) },
      },
    },
  } as unknown as System
}

function withSystem(node: ReactNode): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <SystemProvider system={mockSystem()}>{node}</SystemProvider>
    </QueryClientProvider>
  )
}

function mount(
  kind: PickerKind,
  initial: readonly number[],
  listState: DeviceListState,
  cameras: HarnessProps['cameras'] = CAMERAS,
  others: HarnessProps['others'] = [],
  savedHadDevices = false,
) {
  const seen = vi.fn<(next: readonly number[]) => void>()
  // The Devices tab's list is always open (R15), and an open device list reads
  // the site zones for its "Group by" — so the harness provides a client.
  render(
    withSystem(
      <Harness
        kind={kind}
        initial={initial}
        listState={listState}
        cameras={cameras}
        others={others}
        savedHadDevices={savedHadDevices}
        seen={seen}
      />,
    ),
  )
  return seen
}

/** The ✕ of a selected chip — every picker draws the selection as chips (D636). */
function removeChip(text: string): HTMLElement {
  return screen.getByRole('button', { name: `Remove ${text}` })
}

describe.each<PickerKind>([
  'conditions',
  'devicesTab',
  'digest',
])('the %s picker — a selected device the hub no longer has', (kind) => {
  it('draws it as removed, and unchecking it takes it out of the value', () => {
    const seen = mount(kind, [5, 42], 'answered')
    expect(screen.getByText(REMOVED_42)).toBeTruthy()
    fireEvent.click(removeChip(REMOVED_42))
    expect(seen).toHaveBeenLastCalledWith([5])
    expect(screen.queryByText(REMOVED_42)).toBeNull()
  })

  it('a pending list never shows the "applies to all" hint, nor calls an id removed', () => {
    mount(kind, [42], 'pending', [])
    expect(
      screen.getByText(kind === 'devicesTab' ? 'Loading devices…' : 'Loading cameras…'),
    ).toBeTruthy()
    expect(screen.queryByText(APPLIES_TO_ALL)).toBeNull()
    expect(screen.queryByText(REMOVED_42)).toBeNull()
  })

  it('a failed list says so and still lets each selected id be removed', () => {
    const seen = mount(kind, [1, 42], 'failed', [])
    expect(screen.getByText(/did not return its devices/)).toBeTruthy()
    expect(screen.queryByText(REMOVED_42)).toBeNull()
    expect(screen.queryByText(APPLIES_TO_ALL)).toBeNull()
    fireEvent.click(removeChip('Device #42'))
    expect(seen).toHaveBeenLastCalledWith([1])
  })
})

describe.each<PickerKind>([
  'conditions',
  'digest',
])('the %s camera picker — a selected NON-camera device', (kind) => {
  it('is named from the fleet, never called removed, and still deselects', () => {
    const seen = mount(kind, [1, 70], 'answered', CAMERAS, [{ id: 70, name: 'Door sensor' }])
    expect(screen.queryByText('Device #70 — removed')).toBeNull()
    fireEvent.click(removeChip('Door sensor'))
    expect(seen).toHaveBeenLastCalledWith([1])
  })
})

describe('the widening warning', () => {
  it.each<PickerKind>([
    'conditions',
    'devicesTab',
  ])('%s: removing the ONLY (removed) device warns the rule now applies to all', (kind) => {
    mount(kind, [42], 'answered', [])
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
    expect(screen.queryByText(APPLIES_TO_ALL)).toBeNull()
    fireEvent.click(removeChip(REMOVED_42))
    expect(screen.getByTestId('devices-widen-warning')).toBeTruthy()
  })

  it.each<PickerKind>([
    'conditions',
    'devicesTab',
  ])('%s: a fresh mount of a rule SAVED with devices and empty now still warns', (kind) => {
    mount(kind, [], 'answered', CAMERAS, [], true)
    expect(screen.getByTestId('devices-widen-warning')).toBeTruthy()
  })

  it.each<PickerKind>([
    'conditions',
    'devicesTab',
  ])('%s: a rule saved empty and empty now does not warn', (kind) => {
    mount(kind, [], 'answered', CAMERAS, [], false)
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
  })

  it('digest: an empty selection is refused elsewhere, never called "all"', () => {
    mount('digest', [42], 'answered')
    fireEvent.click(removeChip(REMOVED_42))
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
  })

  it('an answered EMPTY list with nothing selected is the "applies to all" hint', () => {
    mount('conditions', [], 'answered', [])
    expect(screen.getByText(APPLIES_TO_ALL)).toBeTruthy()
  })
})

describe('the action step device', () => {
  const FORM: NcRuleActionsFormState = {
    onActivation: [],
    onDeactivation: [],
    onTrigger: [
      {
        kind: 'do',
        action: {
          kind: 'cap',
          deviceId: 42,
          cap: 'switch',
          method: 'setState',
          args: { on: true },
        },
      },
    ],
    onTriggerOff: [],
    buttons: [],
  }

  function renderActions(devicesState: DeviceListState) {
    render(
      withSystem(
        <NotificationRuleActions
          value={FORM}
          onChange={() => {}}
          devices={devicesState === 'answered' ? CAMERAS : []}
          devicesState={devicesState}
          sequences={[]}
        />,
      ),
    )
  }

  it('names a step device the answered fleet lacks as removed, still selected', () => {
    renderActions('answered')
    expect(screen.getByTestId('device-do-action-device-picker')).toBeTruthy()
    expect(screen.getByText(REMOVED_42)).toBeTruthy()
  })

  it('an unanswered fleet names the id without claiming removal', () => {
    renderActions('failed')
    expect(screen.getByTestId('device-do-action-device-picker')).toBeTruthy()
    expect(screen.queryByText(REMOVED_42)).toBeNull()
  })
})

describe('the alarm non-blocking picker', () => {
  const COVERAGE: NcAlarmModeCoverage = {
    mode: 'away',
    ruleCount: 1,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [5],
    skippedDevices: [],
  }
  const SETTINGS: NcAlarmSettings = {
    entryDelaySec: 30,
    exitDelaySec: 45,
    triggeredDurationSec: 120,
    announceArm: false,
    announceTargets: [],
    nonBlocking: [{ mode: 'away', deviceIds: [42] }],
    blocking: [],
    secureOnArmOff: [],
    modeDelays: [],
  }

  function renderCard(devicesState: DeviceListState) {
    const names = alarmDeviceNames(new Map([[5, 'Garden']]), devicesState)
    const onSwitch = vi.fn()
    render(
      <AlarmModeCard
        coverage={COVERAGE}
        live={undefined}
        settings={SETTINGS}
        names={names}
        openingsCheck={{ status: 'answered', openingIds: new Set([5]) }}
        rows={alarmSensorRows({
          candidates: [5, 42].map((id) => ({ id, name: names.nameOf(id) })),
          removedIds: new Set([5, 42].filter(names.isRemoved)),
          coverage: COVERAGE,
          nonBlocking: [42],
          blocking: [],
          secureOnArmOff: [],
          sensors: { status: 'pending' },
        })}
        sensorsRetry={null}
        inFlight={null}
        onSwitch={onSwitch}
        zones={{ state: 'answered', zones: [] }}
        onDelayEdit={() => {}}
        onPostTriggeredEdit={() => {}}
        onScheduleEdit={() => {}}
        onNotifyEdit={onNotifyEdit}
        disabled={false}
      />,
    )
    return onSwitch
  }
  const onNotifyEdit = vi.fn()

  it('shows the mode its two notification switches OFF, and a toggle is ONE edit (D706)', () => {
    onNotifyEdit.mockClear()
    renderCard('answered')
    const during = screen.getByTestId('alarm-notify-away-notifyDuringEntryDelay')
    const rewatched = screen.getByTestId('alarm-notify-away-notifySensorRewatched')
    expect(during.getAttribute('aria-checked')).toBe('false')
    expect(rewatched.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(during)
    expect(onNotifyEdit).toHaveBeenCalledWith('notifyDuringEntryDelay', true)
  })

  it('names a listed device the fleet lacks as a "Removed" row, switch OFF, still switchable', () => {
    const onSwitch = renderCard('answered')
    expect(screen.getByText(REMOVED_42)).toBeTruthy()
    const row = screen.getByText(REMOVED_42).closest('tr')
    if (row === null) throw new Error('no row')
    expect(within(row).getByTestId('alarm-cell-state-badge').textContent).toBe('Removed')
    const sw = within(row).getByRole('switch')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('an unanswered fleet never calls it removed', () => {
    renderCard('pending')
    expect(screen.queryByText(REMOVED_42)).toBeNull()
    expect(screen.queryByText('Removed')).toBeNull()
  })
})

/**
 * The seed has to REACH the picker: `RuleConditionsEditor` → `ConditionWidget`
 * → `SystemEventField` → `DeviceListField`. Mounted at that seam, so a prop
 * dropped anywhere on the way fails here.
 */
describe('RuleConditionsEditor — the system-event device filter as opened', () => {
  const SYSTEM: NcConditionDescriptor = {
    id: 'systemEvent',
    group: 'system',
    label: 'System event',
    valueType: 'systemEvent',
    operator: 'in',
    appliesTo: ['system-event'],
    phase: 'P1',
  }

  function renderSystem(savedConditions: NcConditions | undefined) {
    render(
      withSystem(
        <MemoryRouter>
          <RuleConditionsEditor
            classScope={ruleScopeDraftOf<string>(undefined, undefined)}
            onClassScopeChange={() => {}}
            catalog={[SYSTEM]}
            taxonomy={undefined}
            delivery="system-event"
            conditions={{ systemEvent: { kinds: ['device-offline'] } }}
            savedConditions={savedConditions}
            schedule={undefined}
            deviceIds={[]}
            cameras={CAMERAS}
            fleet={{ state: 'answered', devices: CAMERAS }}
            gateable={[]}
            gateableScenes={[]}
            onConditionsChange={() => {}}
            onScheduleChange={() => {}}
          />
        </MemoryRouter>,
      ),
    )
  }

  it('saved with devices, empty now → warns on a fresh mount', () => {
    renderSystem({
      systemEvent: { kinds: ['device-offline'], deviceIds: [42] },
    })
    expect(screen.getByTestId('devices-widen-warning')).toBeTruthy()
  })

  it('saved without devices → no warning', () => {
    renderSystem({ systemEvent: { kinds: ['device-offline'] } })
    fireEvent.click(screen.getByRole('radio', { name: 'Only these' }))
    // The list opens on demand; the fleet's devices are in it.
    const include = screen.getByTestId('system-event-include')
    fireEvent.click(within(include).getByRole('button', { name: /add devices/i }))
    expect(within(include).getByText('Garden')).toBeTruthy()
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
  })
})

/**
 * D636 at the system-event widget: the exclude list is authored with the same
 * picker (every device, not cameras), and a battery/consumable kind behind a
 * device-type filter is WARNED about — the shape of the live two-week outage.
 */
describe('SystemEventField — exclude list and the battery warning', () => {
  const FLEET = [
    { id: 1, name: 'Front door', type: 'camera', location: 'Fuori' },
    {
      id: 3615,
      name: 'Termometro sala server',
      type: 'sensor',
      location: 'Server',
    },
    { id: 4385, name: 'Robot piano terra', type: 'vacuum', location: 'Hall' },
  ]

  function renderField(value: NcSystemEventCondition, onChange = vi.fn()) {
    render(
      withSystem(
        <MemoryRouter>
          <SystemEventField
            family="device-events"
            value={value}
            cameras={[{ id: 1, name: 'Front door' }]}
            allDevices={FLEET}
            fleet={{ state: 'answered', devices: FLEET }}
            savedHadDevices={false}
            onChange={onChange}
          />
        </MemoryRouter>,
      ),
    )
    return onChange
  }

  it('warns when battery kinds meet a device-type filter', () => {
    renderField({
      kinds: ['device-battery-low', 'device-offline'],
      deviceTypes: ['camera'],
    })
    expect(screen.getByTestId('battery-device-types-warning')).toBeTruthy()
  })

  it('does not warn without a type filter', () => {
    renderField({ kinds: ['device-battery-low'] })
    expect(screen.queryByTestId('battery-device-types-warning')).toBeNull()
  })

  it('excludes a NON-camera device picked from the whole fleet', () => {
    const onChange = renderField({ kinds: ['device-battery-low'] })
    fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
    const exclude = screen.getByTestId('system-event-exclude')
    fireEvent.click(within(exclude).getByRole('button', { name: /add devices/i }))
    fireEvent.click(within(exclude).getByText('Termometro sala server'))
    expect(onChange).toHaveBeenLastCalledWith({
      kinds: ['device-battery-low'],
      excludeDeviceIds: [3615],
    })
  })

  it('draws a stored exclusion the fleet no longer has as removed, and removes it', () => {
    const onChange = renderField({
      kinds: ['device-battery-low'],
      excludeDeviceIds: [42],
    })
    const exclude = screen.getByTestId('system-event-exclude')
    expect(within(exclude).getByText(REMOVED_42)).toBeTruthy()
    fireEvent.click(within(exclude).getByRole('button', { name: `Remove ${REMOVED_42}` }))
    expect(onChange).toHaveBeenLastCalledWith({
      kinds: ['device-battery-low'],
    })
  })
})
