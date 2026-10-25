/**
 * The Alarm tab's device roster reads the SHARED fleet query.
 *
 * It used to be `system.trpcClient.deviceManager.listAll.query({ projection:
 * 'slim' })` under the private key `['deviceManager','listAll',
 * 'alarm-coverage']`. The projection was already right; the CLIENT was not, and
 * that half is invisible to D274:
 *
 *   - `applyFleetQueryDefaults` registers the window on the tRPC key PREFIX
 *     `[['deviceManager','listAll']]`. A single-nested key does not match it,
 *     so the window never applied — this read went out at `staleTime: 0` on
 *     every mount of the tab.
 *   - The ~20 `[['deviceManager']]` invalidations do not match it either, so a
 *     renamed lock kept its old name in the coverage summary.
 *
 * The page reads exactly two fields off each row — `id` and `name` — which is
 * why `slim` is safe here BY FIELD: slim drops only `config`, `metadata` and
 * `sourceInfo`. The second test pins that the name actually renders, so a
 * projection that stopped carrying it would fail rather than silently print
 * `#42`.
 *
 * Every device, not just cameras: an alarm panel arms locks and sirens.
 */
import { NC_ALARM_SENSORS_MAX, type NcAlarmConfig, type NcAlarmSensors } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'

const FLEET_ROWS: readonly FleetRow[] = [
  { id: 42, name: 'Serratura front door', type: 'lock', location: 'Sala' },
  { id: 101, name: 'Camera atrio', type: 'camera', isCamera: true },
  // A contact only a HOME rule covers — an opening of the household all the
  // same, offered under away and marked "never blocks" (D636).
  { id: 77, name: 'Finestra studio', type: 'sensor' },
]

const listAllHook = vi.fn(
  (_input?: FleetListInput, _options?: FleetListOptions): FleetListResult =>
    fleetListResult(FLEET_ROWS),
)

/** Named so the spec can assert the RAW client is never reached. */
const mockListAllRaw = vi.fn(() => Promise.resolve([]))

const ALARM_CONFIG: NcAlarmConfig = {
  deviceId: 900,
  settings: {
    entryDelaySec: 30,
    exitDelaySec: 45,
    triggeredDurationSec: 120,
    announceArm: false,
    announceTargets: [],
    nonBlocking: [],
    blocking: [],
    secureOnArmOff: [],
    modeDelays: [],
  },
  coverage: [
    {
      mode: 'away',
      ruleCount: 1,
      allDevices: false,
      allDevicesExcept: [],
      // 42 is a lock, 50 a contact, 101 a camera: all covered, only two are openings.
      deviceIds: [42, 50, 101],
      skippedDevices: [{ deviceId: 101, reason: 'muted' }],
    },
    {
      mode: 'home',
      ruleCount: 1,
      allDevices: false,
      allDevicesExcept: [],
      deviceIds: [77],
      skippedDevices: [],
    },
  ],
  live: {
    state: 'disarmed',
    targetMode: null,
    availableModes: ['home', 'away'],
    openings: [
      {
        mode: 'away',
        devices: [{ deviceId: 50, name: 'Porch', state: 'open', blocking: true }],
        unknown: [],
      },
      { mode: 'home', devices: [], unknown: [] },
    ],
    exclusions: [{ deviceId: 51, name: 'Finestra bathroom', phase: 'open' }],
    bypassedInputs: [],
  },
}

/** An answer as an older hub sends it: `modeDelays` (D697) and `nonBlocking` (D636) may be absent. */
type AlarmConfigOnTheWire = Omit<NcAlarmConfig, 'settings'> & {
  readonly settings: Omit<NcAlarmConfig['settings'], 'modeDelays' | 'nonBlocking'> &
    Partial<Pick<NcAlarmConfig['settings'], 'modeDelays' | 'nonBlocking'>>
}

const mockGetAlarmConfig = vi.fn((): Promise<AlarmConfigOnTheWire> => Promise.resolve(ALARM_CONFIG))
interface TargetFixture {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
}
const mockListTargets = vi.fn((): Promise<readonly TargetFixture[]> => Promise.resolve([]))
const mockListRules = vi.fn(
  (): Promise<{ rules: readonly unknown[] }> => Promise.resolve({ rules: [] }),
)
const mockSetAlarmConfig = vi.fn(
  (_i: unknown): Promise<AlarmConfigOnTheWire> => Promise.resolve(ALARM_CONFIG),
)

const SENSORS_ANSWER: NcAlarmSensors = {
  sensors: [
    {
      deviceId: 42,
      reading: 'closed',
      state: 'locked',
      unknownWhy: null,
      online: true,
      controllable: false,
    },
    {
      deviceId: 77,
      reading: 'closed',
      state: 'closed',
      unknownWhy: null,
      online: true,
      controllable: false,
    },
    {
      deviceId: 50,
      reading: 'open',
      state: 'open',
      unknownWhy: null,
      online: true,
      controllable: false,
    },
  ],
  readAt: 1,
}
const mockGetAlarmSensors = vi.fn(
  (_i?: unknown): Promise<NcAlarmSensors> => Promise.resolve(SENSORS_ANSWER),
)
const mockListSiteZones = vi.fn(() => Promise.resolve([]))

interface CapsInput {
  readonly capNames: readonly string[]
}
/** Which devices are bound to which caps — 101 is a camera, never an opening. */
const CAPS_BY_ID: ReadonlyMap<number, readonly string[]> = new Map([
  [42, ['lock-control']],
  [77, ['contact']],
  [101, ['camera-stream', 'motion']],
])
const answerIdsByCaps = (input: CapsInput): Promise<readonly number[]> =>
  Promise.resolve(
    [...CAPS_BY_ID]
      .filter(([, caps]) => caps.some((cap) => input.capNames.includes(cap)))
      .map(([id]) => id),
  )
const mockListDeviceIdsByCaps = vi.fn(answerIdsByCaps)

interface CustomInput {
  readonly addonId: string
  readonly action: string
  readonly input: unknown
}
const mockCustom = vi.fn((call: CustomInput): Promise<unknown> => {
  if (call.action === 'nc.armAlarm') {
    return Promise.resolve({
      outcome: 'refused',
      refusalId: 'refusal-1',
      blocking: [{ deviceId: 50, name: 'Porch', state: 'open' }],
    })
  }
  if (call.action === 'nc.armAlarmAnyway') {
    return Promise.resolve({
      outcome: 'arming',
      excluded: [{ deviceId: 50, name: 'Porch', state: 'open' }],
    })
  }
  return Promise.resolve({ success: true })
})

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const { useQuery } = await import('@tanstack/react-query')
  return {
    ...real,
    useDeviceManagerListAll: (input?: FleetListInput, options?: FleetListOptions) =>
      listAllHook(input, options),
    // Real hook closes over importActual's useSystem; drive zones off the same mock.
    usePickerSiteZones: (enabled: boolean) => {
      const query = useQuery({
        queryKey: ['deviceManager', 'listSiteZones', 'alarm-test'],
        enabled,
        queryFn: () => mockListSiteZones(),
      })
      const { data, isError } = query
      if (data !== undefined) return { state: 'answered' as const, zones: data }
      return isError ? { state: 'failed' as const } : { state: 'pending' as const }
    },
    useSystem: () => ({
      trpcClient: {
        notificationRules: {
          getAlarmConfig: { query: mockGetAlarmConfig },
          getAlarmSensors: { query: mockGetAlarmSensors },
          listRules: { query: mockListRules },
          setAlarmConfig: { mutate: mockSetAlarmConfig },
          createAlarmProfile: { mutate: mockSetAlarmConfig },
          renameAlarmProfile: { mutate: mockSetAlarmConfig },
          deleteAlarmProfile: { mutate: mockSetAlarmConfig },
          activateAlarmProfile: { mutate: mockSetAlarmConfig },
        },
        notificationOutput: { listTargets: { query: mockListTargets } },
        addons: { custom: { mutate: mockCustom } },
        deviceManager: {
          listAll: { query: mockListAllRaw },
          listDeviceIdsByCaps: { query: mockListDeviceIdsByCaps },
          listSiteZones: { query: mockListSiteZones },
        },
      },
    }),
  }
})

import { NotificationAlarmPage } from '../NotificationAlarm'
import { listedUncoveredWords } from '../alarm-sensor-table'

/** Selects the mode's tab when another mode is shown: one mode is rendered at a time. */
function openMode(mode: string): void {
  if (screen.queryByTestId(`alarm-tab-${mode}`)?.getAttribute('data-state') === 'active') return
  const tab = screen.queryByTestId(`alarm-tab-${mode}`)
  if (tab !== null) {
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
  }
}

/** A mode's sensor list, after selecting its tab. */
function sensorsOf(mode: string): HTMLElement {
  openMode(mode)
  return screen.getByTestId(`alarm-sensors-${mode}`)
}

/** The device ids of a mode's sensor table, read off its switches. */
function rowIds(mode: string): readonly string[] {
  // Controllable openings render TWO switches (blocks + secure-on-arm); unique by id.
  return [
    ...new Set(
      within(sensorsOf(mode))
        .getAllByRole('switch')
        .map((el) => el.getAttribute('data-device-id') ?? ''),
    ),
  ].toSorted()
}

function rowOf(mode: string, id: string): HTMLElement {
  const sw = within(sensorsOf(mode))
    .getAllByRole('switch')
    .find((el) => el.getAttribute('data-device-id') === id)
  const row = sw?.closest<HTMLElement>('tr, [data-data-table-card]')
  if (row === null || row === undefined) throw new Error(`no row ${id} in ${mode}`)
  return row
}

function switchOf(mode: string, id: string): HTMLElement {
  // Prefer the Blocks switch — controllable rows also have Secure-on-arm.
  return within(rowOf(mode, id)).getByTestId('alarm-switch-blocks')
}

function cell(mode: string, id: string, name: string): string {
  return within(rowOf(mode, id)).getByTestId(`alarm-cell-${name}`).textContent ?? ''
}

/** The short word in a state/coverage badge — never a sentence. */
function badge(mode: string, id: string, name: string): string {
  return within(rowOf(mode, id)).getByTestId(`alarm-cell-${name}-badge`).textContent ?? ''
}

/** The explanation under the badge, or null when the cell has none. */
function note(mode: string, id: string, name: string): string | null {
  return within(rowOf(mode, id)).queryByTestId(`alarm-cell-${name}-note`)?.textContent ?? null
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationAlarmPage />
    </QueryClientProvider>,
  )
}

describe('NotificationAlarm page', () => {
  beforeEach(() => {
    listAllHook.mockClear()
    mockListAllRaw.mockClear()
  })

  it('reads the fleet through the shared client, slim, and never through the raw tRPC client', () => {
    renderPage()
    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      expect(input?.projection).toBe('slim')
      // Not cameras-only: an alarm panel arms locks and sirens too.
      expect(input?.isCamera).toBeUndefined()
      // D274 owns the window on the query client.
      expect(options?.staleTime).toBeUndefined()
    }
    expect(mockListAllRaw).not.toHaveBeenCalled()
  })

  it('names the covered and the skipped device off the fleet rows', async () => {
    renderPage()
    // Both come out of the `id → name` map built from the shared query. A
    // projection that dropped `name` would print an id here instead.
    await waitFor(() => expect(screen.getByTestId('alarm-coverage')).toBeTruthy())
    // The coverage words are the badge tooltip; the skipped device's, the skip badge's.
    const covers = within(screen.getByTestId('alarm-coverage')).getByTestId('alarm-covers')
    expect(covers.getAttribute('title')).toContain('Serratura front door')
    const skipped = within(screen.getByTestId('alarm-coverage')).getByTestId('alarm-skipped')
    expect(skipped.getAttribute('title')).toContain('Camera atrio')
  })
})

describe('NotificationAlarm — live panel', () => {
  beforeEach(() => {
    mockCustom.mockClear()
    mockSetAlarmConfig.mockClear()
    mockListDeviceIdsByCaps.mockClear()
  })
  afterEach(() => {
    mockGetAlarmConfig.mockReset()
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
  })

  it('shows a refused arm by name and arms anyway with THAT refusal id', async () => {
    renderPage()
    const arm = await screen.findByTestId('alarm-arm-away')
    fireEvent.click(arm)
    const panel = await screen.findByTestId('alarm-refused')
    expect(panel.textContent).toContain('Porch')
    expect(mockCustom).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      action: 'nc.armAlarm',
      input: { mode: 'away' },
    })
    fireEvent.click(within(panel).getByRole('button', { name: /arm anyway/i }))
    await waitFor(() =>
      expect(mockCustom).toHaveBeenCalledWith({
        addonId: 'pipeline-analytics',
        action: 'nc.armAlarmAnyway',
        input: { refusalId: 'refusal-1' },
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('alarm-refused')).toBeNull())
  })

  it('lists the current exclusions with their phase', async () => {
    renderPage()
    const list = await screen.findByTestId('alarm-exclusions')
    expect(list.textContent).toContain('Finestra bathroom')
    expect(list.textContent).toContain('ignored until it closes')
  })

  it('has no panel Recipients section — delivery is via alarm rules only', async () => {
    renderPage()
    await screen.findByTestId('alarm-coverage')
    expect(screen.queryByTestId('alarm-recipients')).toBeNull()
    expect(screen.queryByTestId('alarm-announce-toggle')).toBeNull()
  })

  it('has NO device picker on the mode card; the table lists every opening, never a camera', async () => {
    renderPage()
    const card = await screen.findByTestId('alarm-nonblocking-away')
    await waitFor(() => expect(within(card).queryByTestId('alarm-openings-checking')).toBeNull())
    expect(within(card).queryByTestId('device-picker-panel')).toBeNull()
    expect(within(card).queryByRole('button', { name: /add devices|edit/i })).toBeNull()
    // 42 (a lock) and 50 (a contact) are covered by an away rule; 77 is a
    // contact only HOME covers (hidden under away, Q2). 101 is a camera: never.
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    // ONE targeted, ids-only read — never a bindings batch over the fleet.
    expect(mockListDeviceIdsByCaps).toHaveBeenCalledTimes(1)
    expect(mockListDeviceIdsByCaps).toHaveBeenCalledWith({
      capNames: ['contact', 'cover', 'lock-control', 'switch'],
    })
  })

  it('the Checked-when-arming cell equals the arm check; a sensor no rule of the mode covers is not a row (Q2)', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    expect(cell('away', '42', 'coverage')).toBe('Yes')
    expect(
      within(rowOf('away', '42')).getByTestId('alarm-cell-name').getAttribute('data-muted'),
    ).toBeNull()
    // 77 is a contact only HOME's rule names: absent under away, a row under home.
    expect(within(sensorsOf('away')).queryByText('Device #77')).toBeNull()
    expect(rowIds('home')).toEqual(['77'])
    // Hidden for being uncovered is not "hidden by filters".
    expect(screen.queryByTestId('alarm-rows-hidden')).toBeNull()
  })

  it('a device covered only by an all-devices rule is hidden — the arm check never reads it', async () => {
    mockGetAlarmConfig.mockImplementation(() =>
      Promise.resolve({
        ...ALARM_CONFIG,
        coverage: [
          {
            mode: 'away',
            ruleCount: 2,
            allDevices: true,
            allDevicesExcept: [],
            deviceIds: [42],
            skippedDevices: [],
          },
          ...ALARM_CONFIG.coverage.filter((c) => c.mode !== 'away'),
        ],
      }),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42']))
    expect(cell('away', '42', 'coverage')).toBe('Yes')
  })

  it('an uncovered sensor the mode still lists is shown, labelled, and its switch removes the entry (D49)', async () => {
    mockGetAlarmConfig.mockImplementation(() =>
      Promise.resolve({
        ...ALARM_CONFIG,
        settings: { ...ALARM_CONFIG.settings, nonBlocking: [{ mode: 'away', deviceIds: [77] }] },
      }),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50', '77']))
    expect(badge('away', '77', 'coverage')).toBe('No')
    expect(note('away', '77', 'coverage')).toBe(listedUncoveredWords())
    // The row is visibly muted: the class sits on the row/card itself (a cell's own
    // text colour would win over a colour set on the row).
    expect(rowOf('away', '77').className).toMatch(/\bopacity-60\b/)
    expect(rowOf('away', '42').className).not.toMatch(/opacity-60/)
    expect(
      within(rowOf('away', '77')).getByTestId('alarm-cell-name').getAttribute('data-muted'),
    ).toBe('true')
    expect(switchOf('away', '77').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(switchOf('away', '77'))
    await waitFor(() =>
      expect(mockSetAlarmConfig).toHaveBeenCalledWith({
        patch: { nonBlockingEdit: { mode: 'away', deviceId: 77, nonBlocking: false } },
      }),
    )
  })

  it('a mode no sensor is covered in says so — and not while the household scan is pending (D315)', async () => {
    mockGetAlarmConfig.mockImplementation(() =>
      Promise.resolve({
        ...ALARM_CONFIG,
        coverage: ALARM_CONFIG.coverage.map((c) =>
          c.mode === 'away' ? { ...c, deviceIds: [101], skippedDevices: [] } : c,
        ),
        live: ALARM_CONFIG.live === undefined ? undefined : { ...ALARM_CONFIG.live, openings: [] },
      }),
    )
    let answer: (ids: readonly number[]) => void = () => {}
    mockListDeviceIdsByCaps.mockImplementationOnce(
      () => new Promise<readonly number[]>((resolve) => (answer = resolve)),
    )
    renderPage()
    await screen.findByTestId('alarm-tab-away')
    openMode('away')
    const card = await screen.findByTestId('alarm-nonblocking-away')
    await waitFor(() => expect(mockListDeviceIdsByCaps).toHaveBeenCalled())
    expect(within(card).queryByTestId('alarm-sensors-none')).toBeNull()
    answer([42, 77])
    await waitFor(() => expect(within(card).getByTestId('alarm-sensors-none')).toBeTruthy())
    expect(within(card).getByTestId('alarm-sensors-none').textContent).toBe(
      'No sensor is covered by a rule of this mode.',
    )
    expect(within(card).queryByTestId('alarm-sensors-away')).toBeNull()
  })

  it('a skipped-but-covered device still blocks arming, and says why it is not notified', async () => {
    mockGetAlarmConfig.mockImplementationOnce(() =>
      Promise.resolve({
        ...ALARM_CONFIG,
        coverage: [
          {
            mode: 'away',
            ruleCount: 1,
            allDevices: false,
            allDevicesExcept: [],
            deviceIds: [42],
            skippedDevices: [{ deviceId: 42, reason: 'muted' }],
          },
          {
            mode: 'home',
            ruleCount: 1,
            allDevices: false,
            allDevicesExcept: [],
            deviceIds: [77],
            skippedDevices: [],
          },
        ],
      }),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42']))
    expect(badge('away', '42', 'coverage')).toBe('Skipped')
    expect(note('away', '42', 'coverage')).toBe('Blocks arming; notifications skipped: muted')
  })

  it('the state cell is never "closed" until the sensors read ANSWERED (D315)', async () => {
    let answer: (a: NcAlarmSensors) => void = () => {}
    mockGetAlarmSensors.mockImplementationOnce(
      () => new Promise<NcAlarmSensors>((resolve) => (answer = resolve)),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    expect(badge('away', '42', 'state')).toBe('Checking…')
    expect(screen.getByTestId('alarm-sensors-away').textContent).not.toMatch(/closed/i)
    answer({
      sensors: [
        {
          deviceId: 42,
          reading: 'closed',
          state: 'locked',
          unknownWhy: null,
          online: true,
          controllable: false,
        },
      ],
      readAt: 2,
    })
    await waitFor(() => expect(cell('away', '42', 'state')).toBe('locked'))
    expect(badge('away', '50', 'state')).toBe('Unknown')
    expect(note('away', '50', 'state')).toBe('Not answered')
  })

  it('an older hub (the read is missing by NAME) says so and is asked ONCE', async () => {
    mockGetAlarmSensors.mockReset()
    mockGetAlarmSensors.mockImplementation(() =>
      Promise.reject(
        new Error(
          "child-cap-dispatch: method 'getAlarmSensors' not found on provider 'notification-rules'",
        ),
      ),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    await waitFor(() =>
      expect(note('away', '42', 'state')).toMatch(/does not report sensor states/),
    )
    expect(mockGetAlarmSensors).toHaveBeenCalledTimes(1)
    mockGetAlarmSensors.mockReset()
    mockGetAlarmSensors.mockImplementation(() => Promise.resolve(SENSORS_ANSWER))
  })

  it('a listed id the answered fleet lacks stays a row reading "Removed", switch OFF (D49)', async () => {
    mockGetAlarmConfig.mockImplementationOnce(() =>
      Promise.resolve({
        ...ALARM_CONFIG,
        settings: { ...ALARM_CONFIG.settings, nonBlocking: [{ mode: 'away', deviceIds: [999] }] },
      }),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50', '999']))
    expect(badge('away', '999', 'state')).toBe('Removed')
    expect(switchOf('away', '999').getAttribute('aria-checked')).toBe('false')
  })

  it('Zone · Location names the zone only from an ANSWERED zones read', async () => {
    let answer: (z: readonly unknown[]) => void = () => {}
    mockListSiteZones.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => (answer = (z) => resolve(z as never[]))),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    expect(cell('away', '42', 'zone')).toBe('Sala')
    expect(cell('away', '42', 'zone')).not.toMatch(/No zone/)
    answer([{ zoneKey: 'giorno', label: 'Zona giorno', locationKeys: ['sala'] }])
    await waitFor(() => expect(cell('away', '42', 'zone')).toBe('Zona giorno · Sala'))
  })

  it('a switch press sends exactly ONE membership edit — never a whole list', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    // 42 is a lock (controllable): Blocks defaults OFF; pressing it turns blocking ON.
    fireEvent.click(switchOf('away', '42'))
    await waitFor(() =>
      expect(mockSetAlarmConfig).toHaveBeenCalledWith({
        patch: { blockingEdit: { mode: 'away', deviceId: 42, blocking: true } },
      }),
    )
    expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1)
    // 50 is a contact: Blocks defaults ON; pressing it marks non-blocking.
    fireEvent.click(switchOf('away', '50'))
    await waitFor(() =>
      expect(mockSetAlarmConfig).toHaveBeenCalledWith({
        patch: { nonBlockingEdit: { mode: 'away', deviceId: 50, nonBlocking: true } },
      }),
    )
  })
})

describe('NotificationAlarm — one switch write at a time', () => {
  beforeEach(() => {
    mockSetAlarmConfig.mockReset()
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
  })

  it('refuses a second press BY NAME while one is in flight; two presses in one tick send ONE', async () => {
    let finish: (c: NcAlarmConfig) => void = () => {}
    mockSetAlarmConfig.mockImplementation(
      () => new Promise<NcAlarmConfig>((resolve) => (finish = resolve)),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    const first = switchOf('away', '42')
    const second = switchOf('away', '50')
    act(() => {
      fireEvent.click(first)
      fireEvent.click(second)
    })
    expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1)
    const refused = await screen.findByTestId('alarm-switch-refused')
    expect(refused.textContent).toContain('Serratura front door')
    expect(first.getAttribute('aria-busy')).toBe('true')
    // A later press while it is still pending: still nothing sent.
    fireEvent.click(switchOf('away', '50'))
    expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1)
    finish({
      ...ALARM_CONFIG,
      settings: {
        ...ALARM_CONFIG.settings,
        blocking: [{ mode: 'away', deviceIds: [42] }],
      },
    })
    await waitFor(() => expect(switchOf('away', '42').getAttribute('aria-busy')).toBeNull())
    expect(screen.queryByTestId('alarm-switch-not-landed')).toBeNull()
    // The gate is released: the next press goes out.
    fireEvent.click(switchOf('away', '50'))
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(2))
  })

  it('a hub answer that did not apply the change says so (another editor, or an old hub)', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    fireEvent.click(switchOf('away', '42'))
    const note = await screen.findByTestId('alarm-switch-not-landed')
    expect(note.textContent).toMatch(
      /another editor may have changed it, or the hub needs an update/,
    )
  })

  it('a rejected write names the device, the mode and the error', async () => {
    mockSetAlarmConfig.mockImplementation(() => Promise.reject(new Error('boom')))
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    fireEvent.click(switchOf('away', '42'))
    const note = await screen.findByTestId('alarm-switch-failed')
    expect(note.textContent).toBe('Could not change Serratura front door for Away: boom')
  })
})

describe('NotificationAlarm — a FAILED fleet read (review M2)', () => {
  it('never leaves the openings "checking" forever: they are rows, named by id', async () => {
    listAllHook.mockImplementationOnce(() => ({ data: undefined, isLoading: false, isError: true }))
    listAllHook.mockImplementation(() => ({ data: undefined, isLoading: false, isError: true }))
    renderPage()
    const picker = await screen.findByTestId('alarm-nonblocking-away')
    await waitFor(() => expect(within(picker).queryByTestId('alarm-openings-checking')).toBeNull())
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    listAllHook.mockImplementation((_input?: FleetListInput, _options?: FleetListOptions) =>
      fleetListResult(FLEET_ROWS),
    )
  })
})

describe('NotificationAlarm — the non-blocking picker when bindings cannot be read', () => {
  beforeEach(() => {
    mockListDeviceIdsByCaps.mockReset()
  })

  it('an older hub without the method: says it could not check, keeps open devices, retries', async () => {
    mockListDeviceIdsByCaps.mockImplementationOnce(() =>
      Promise.reject(new Error('No procedure found on path "deviceManager.listDeviceIdsByCaps"')),
    )
    mockListDeviceIdsByCaps.mockImplementation(answerIdsByCaps)
    renderPage()
    const picker = await screen.findByTestId('alarm-nonblocking-away')
    const note = await within(picker).findByTestId('alarm-openings-check-failed')
    expect(note.textContent).toMatch(/couldn.t check/i)
    // Only what the hub READ (50) — never "no opening", never a guess.
    expect(rowIds('away')).toEqual(['50'])
    expect(picker.textContent).not.toMatch(/has no opening/i)

    fireEvent.click(within(note).getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    expect(screen.queryByTestId('alarm-openings-check-failed')).toBeNull()
  })

  it('while the bindings are pending it says it is checking', async () => {
    mockListDeviceIdsByCaps.mockImplementation(() => new Promise<readonly number[]>(() => {}))
    renderPage()
    const picker = await screen.findByTestId('alarm-nonblocking-away')
    expect(within(picker).getByTestId('alarm-openings-checking')).toBeTruthy()
  })
})

describe('NotificationAlarm — arm outcomes and save errors are visible', () => {
  beforeEach(() => {
    mockCustom.mockClear()
    mockSetAlarmConfig.mockReset()
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
    mockListDeviceIdsByCaps.mockImplementation(answerIdsByCaps)
  })

  it('a REJECTED Arm anyway says why and drops the stale refusal', async () => {
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({
        outcome: 'refused',
        refusalId: 'refusal-1',
        blocking: [{ deviceId: 50, name: 'Porch', state: 'open' }],
      }),
    )
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'rejected', reason: 'expired' }),
    )
    renderPage()
    fireEvent.click(await screen.findByTestId('alarm-arm-away'))
    const panel = await screen.findByTestId('alarm-refused')
    fireEvent.click(within(panel).getByRole('button', { name: /arm anyway/i }))
    expect(await screen.findByText(/the refusal expired/i)).toBeTruthy()
    expect(screen.queryByTestId('alarm-refused')).toBeNull()
  })

  it('refused, then refused again: the SECOND refusal replaces the first, and Arm anyway carries its id', async () => {
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({
        outcome: 'refused',
        refusalId: 'refusal-1',
        blocking: [{ deviceId: 50, name: 'Porch', state: 'open' }],
      }),
    )
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({
        outcome: 'refused',
        refusalId: 'refusal-2',
        blocking: [{ deviceId: 51, name: 'Retro', state: 'open' }],
      }),
    )
    mockCustom.mockImplementationOnce(() => Promise.resolve({ outcome: 'arming', excluded: [] }))
    renderPage()
    fireEvent.click(await screen.findByTestId('alarm-arm-away'))
    await waitFor(() => expect(screen.getByTestId('alarm-refused').textContent).toContain('Porch'))
    fireEvent.click(screen.getByTestId('alarm-arm-away'))
    await waitFor(() => expect(screen.getByTestId('alarm-refused').textContent).toContain('Retro'))
    const panel = screen.getByTestId('alarm-refused')
    expect(panel.textContent).not.toContain('Porch')
    fireEvent.click(within(panel).getByRole('button', { name: /arm anyway/i }))
    await waitFor(() =>
      expect(mockCustom).toHaveBeenLastCalledWith({
        addonId: 'pipeline-analytics',
        action: 'nc.armAlarmAnyway',
        input: { refusalId: 'refusal-2' },
      }),
    )
  })

  it('a refusal that names NO device has its own line, and an unnamed one is "Device #id"', async () => {
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({ outcome: 'refused', refusalId: 'refusal-9', blocking: [] }),
    )
    mockCustom.mockImplementationOnce(() =>
      Promise.resolve({
        outcome: 'refused',
        refusalId: 'refusal-10',
        blocking: [{ deviceId: 50, name: '', state: 'open' }],
      }),
    )
    renderPage()
    fireEvent.click(await screen.findByTestId('alarm-arm-away'))
    const panel = await screen.findByTestId('alarm-refused')
    expect(panel.textContent).toMatch(/refused without naming an open device/i)
    expect(panel.textContent).not.toMatch(/these are open/i)
    fireEvent.click(screen.getByTestId('alarm-arm-away'))
    await waitFor(() =>
      expect(screen.getByTestId('alarm-refused').textContent).toContain('Device #50'),
    )
  })

  it('a failed save of another field is shown with the hub message', async () => {
    mockSetAlarmConfig.mockImplementation(() =>
      Promise.reject(new Error('exitDelaySec: at most 600')),
    )
    renderPage()
    openMode('away')
    const input = await screen.findByTestId('alarm-delay-away-exit')
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(await screen.findByText(/could not save/i)).toBeTruthy()
    expect(screen.getByText(/at most 600/i)).toBeTruthy()
  })
})

describe('NotificationAlarm — per-mode delays and the landed check (D697)', () => {
  const WITH_HOME_OVERRIDE: NcAlarmConfig = {
    ...ALARM_CONFIG,
    settings: { ...ALARM_CONFIG.settings, modeDelays: [{ mode: 'home', exitDelaySec: 0 }] },
  }
  const exitInput = async (mode: string): Promise<HTMLInputElement> => {
    await screen.findByTestId(`alarm-tab-${mode}`)
    openMode(mode)
    const el = await screen.findByTestId(`alarm-delay-${mode}-exit`)
    if (!(el instanceof HTMLInputElement)) throw new Error('not an input')
    return el
  }

  beforeEach(() => {
    mockSetAlarmConfig.mockReset()
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(WITH_HOME_OVERRIDE))
    mockGetAlarmConfig.mockReset()
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(WITH_HOME_OVERRIDE))
  })
  afterEach(() => {
    mockGetAlarmConfig.mockReset()
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
  })

  it('an overridden field shows its own value and "Use default"; an inheriting one the global and "Default"', async () => {
    renderPage()
    expect((await exitInput('home')).value).toBe('0')
    expect(screen.getByTestId('alarm-delay-home-exit-default')).toBeTruthy()
    expect((await exitInput('away')).value).toBe('45')
    expect(screen.queryByTestId('alarm-delay-away-exit-default')).toBeNull()
    const away = screen.getByTestId('alarm-delays-away')
    // The three delays (exit, entry, after-trigger seconds) plus the
    // After-trigger ACTION, which inherits its default the same way (aaf37d743).
    expect(within(away).getAllByText('Default').length).toBe(4)
    expect(within(away).getAllByText('Default')[0]?.getAttribute('title')).toBe(
      'Uses the system default (45 s)',
    )
  })

  it('does not expose a global Default delays card — modes inherit system defaults', async () => {
    renderPage()
    await screen.findByTestId('alarm-coverage')
    expect(screen.queryByTestId('alarm-default-delays')).toBeNull()
    expect(screen.getByTestId('alarm-delays-hint').textContent).toMatch(/system defaults/)
  })

  it('typing into an inheriting field and blurring sends that ONE mode edit', async () => {
    renderPage()
    const input = await exitInput('away')
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1))
    expect(mockSetAlarmConfig).toHaveBeenCalledWith({
      patch: { modeDelays: [{ mode: 'away', exitDelaySec: 60 }] },
    })
  })

  it('typing the GLOBAL value into an inheriting field still stores the override', async () => {
    renderPage()
    const input = await exitInput('away')
    fireEvent.change(input, { target: { value: '46' } })
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1))
    expect(mockSetAlarmConfig).toHaveBeenCalledWith({
      patch: { modeDelays: [{ mode: 'away', exitDelaySec: 45 }] },
    })
  })

  it('"Use default" sends null, never 0', async () => {
    renderPage()
    await exitInput('home')
    fireEvent.click(await screen.findByTestId('alarm-delay-home-exit-default'))
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1))
    expect(mockSetAlarmConfig).toHaveBeenCalledWith({
      patch: { modeDelays: [{ mode: 'home', exitDelaySec: null }] },
    })
  })

  it('a hub answer that did not apply the patch renders alarm-save-not-landed', async () => {
    renderPage()
    expect(screen.queryByTestId('alarm-save-not-landed')).toBeNull()
    const input = await exitInput('away')
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    const note = await screen.findByTestId('alarm-save-not-landed')
    expect(note.textContent).toMatch(/did not apply this change/)
  })

  it('an applied patch shows no note', async () => {
    mockSetAlarmConfig.mockImplementation(() =>
      Promise.resolve({
        ...WITH_HOME_OVERRIDE,
        settings: {
          ...WITH_HOME_OVERRIDE.settings,
          modeDelays: [
            { mode: 'home', exitDelaySec: 0 },
            { mode: 'away', exitDelaySec: 60 },
          ],
        },
      }),
    )
    renderPage()
    const input = await exitInput('away')
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(screen.queryByTestId('alarm-save-not-landed')).toBeNull()
  })
})

describe('NotificationAlarm — refused notice lifetime (review T8 LOW-1)', () => {
  beforeEach(() => {
    mockSetAlarmConfig.mockReset()
  })
  afterEach(() => {
    mockSetAlarmConfig.mockReset()
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
  })

  it('clears the "wait for it to finish" line once the write in flight has finished', async () => {
    let finish: (c: NcAlarmConfig) => void = () => {}
    mockSetAlarmConfig.mockImplementation(
      () => new Promise<NcAlarmConfig>((resolve) => (finish = resolve)),
    )
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    act(() => {
      fireEvent.click(switchOf('away', '42'))
      fireEvent.click(switchOf('away', '50'))
    })
    await screen.findByTestId('alarm-switch-refused')
    finish({
      ...ALARM_CONFIG,
      settings: { ...ALARM_CONFIG.settings, nonBlocking: [{ mode: 'away', deviceIds: [42] }] },
    })
    await waitFor(() => expect(switchOf('away', '42').getAttribute('aria-busy')).toBeNull())
    expect(screen.queryByTestId('alarm-switch-refused')).toBeNull()
  })
})

describe('NotificationAlarm — the sensors read (review T8 MEDIUM-1/2)', () => {
  const sensorCalls = (): number => mockGetAlarmSensors.mock.calls.length
  const restoreSensors = (): void => {
    mockGetAlarmSensors.mockReset()
    mockGetAlarmSensors.mockImplementation(() => Promise.resolve(SENSORS_ANSWER))
  }
  beforeEach(restoreSensors)
  afterEach(() => {
    vi.useRealTimers()
    restoreSensors()
    mockListDeviceIdsByCaps.mockReset()
    mockListDeviceIdsByCaps.mockImplementation(answerIdsByCaps)
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
    listAllHook.mockImplementation((_input?: FleetListInput, _options?: FleetListOptions) =>
      fleetListResult(FLEET_ROWS),
    )
  })

  it('stops polling once the hub is known to be too old: still ONE call after minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockGetAlarmSensors.mockImplementation(() =>
      Promise.reject(
        new Error(
          "child-cap-dispatch: method 'getAlarmSensors' not found on provider 'notification-rules'",
        ),
      ),
    )
    renderPage()
    await waitFor(() =>
      expect(note('away', '42', 'state')).toMatch(/does not report sensor states/),
    )
    expect(sensorCalls()).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(sensorCalls()).toBe(1)
  })

  it('a transient failure says so, offers Retry, never reads "closed"; Retry updates the cells', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockGetAlarmSensors.mockImplementation(() => Promise.reject(new Error('socket hang up')))
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    // The query retries twice (1 s, 2 s back-off) before it reports the failure.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    await waitFor(() => expect(note('away', '42', 'state')).toBe('Could not read: socket hang up'))
    expect(screen.getAllByText('Could not read the sensor states.').length).toBeGreaterThan(0)
    expect(screen.getByTestId('alarm-sensors-away').textContent).not.toMatch(/closed/i)
    expect(note('away', '50', 'state')).toBe('Could not read: socket hang up')

    mockGetAlarmSensors.mockImplementation(() => Promise.resolve(SENSORS_ANSWER))
    const before = sensorCalls()
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    await waitFor(() => expect(cell('away', '42', 'state')).toBe('locked'))
    expect(sensorCalls()).toBeGreaterThan(before)
    expect(cell('away', '50', 'state')).toBe('open')
    expect(screen.queryByText('Could not read the sensor states.')).toBeNull()
  })

  describe('more ids than one call may carry', () => {
    const TOTAL = NC_ALARM_SENSORS_MAX + 100
    const ids = Array.from({ length: TOTAL }, (_, i) => i + 1)
    const BIG_FLEET: readonly FleetRow[] = ids.map((id) => ({
      id,
      name: `Lock ${id}`,
      type: 'lock',
    }))
    const closedFor = (deviceIds: readonly number[]): NcAlarmSensors => ({
      sensors: deviceIds.map((deviceId) => ({
        deviceId,
        reading: 'closed',
        state: 'closed',
        unknownWhy: null,
        online: true,
        controllable: false,
      })),
      readAt: 5,
    })
    const bigHousehold = (): void => {
      listAllHook.mockImplementation(() => fleetListResult(BIG_FLEET))
      mockListDeviceIdsByCaps.mockImplementation(() => Promise.resolve(ids))
      // Only covered sensors are rows (Q2): the away rule names every one.
      mockGetAlarmConfig.mockImplementation(() =>
        Promise.resolve({
          ...ALARM_CONFIG,
          coverage: ALARM_CONFIG.coverage.map((c) =>
            c.mode === 'away' ? { ...c, deviceIds: ids, skippedDevices: [] } : c,
          ),
        }),
      )
    }
    const idsOf = (call: readonly unknown[]): readonly number[] => {
      const input = call[0]
      if (typeof input !== 'object' || input === null || !('deviceIds' in input)) return []
      const deviceIds = input.deviceIds
      return Array.isArray(deviceIds) ? deviceIds.filter((v) => typeof v === 'number') : []
    }

    it('reads them in SEQUENCE, in order, each call within the bound', async () => {
      bigHousehold()
      let answerFirst: (a: NcAlarmSensors) => void = () => {}
      mockGetAlarmSensors.mockImplementationOnce(
        () => new Promise<NcAlarmSensors>((resolve) => (answerFirst = resolve)),
      )
      mockGetAlarmSensors.mockImplementation((input?: unknown) =>
        Promise.resolve(closedFor(idsOf([input]))),
      )
      renderPage()
      await waitFor(() => expect(sensorCalls()).toBe(1))
      // The second chunk is not started while the first is unanswered.
      await new Promise((r) => setTimeout(r, 50))
      expect(sensorCalls()).toBe(1)
      answerFirst(closedFor(idsOf(mockGetAlarmSensors.mock.calls[0])))
      await waitFor(() => expect(sensorCalls()).toBe(2))
      const first = idsOf(mockGetAlarmSensors.mock.calls[0])
      const second = idsOf(mockGetAlarmSensors.mock.calls[1])
      expect(first).toEqual(ids.slice(0, NC_ALARM_SENSORS_MAX))
      expect(second).toEqual(ids.slice(NC_ALARM_SENSORS_MAX))
      expect(first.length).toBe(NC_ALARM_SENSORS_MAX)
      expect(second.length).toBe(100)
      // The table pages its rows: row 1 is on the first page.
      await waitFor(() => expect(cell('away', '1', 'state')).toBe('closed'))
    })

    it('one failing chunk fails the WHOLE read: no row reads "closed"', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      bigHousehold()
      mockGetAlarmSensors.mockImplementation((input?: unknown) => {
        const asked = idsOf([input])
        return asked[0] === 1
          ? Promise.resolve(closedFor(asked))
          : Promise.reject(new Error('chunk two failed'))
      })
      renderPage()
      await waitFor(() => expect(sensorCalls()).toBeGreaterThanOrEqual(2))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000)
      })
      await waitFor(() =>
        expect(note('away', '1', 'state')).toBe('Could not read: chunk two failed'),
      )
      // Row 1 was ANSWERED by the first chunk and still reads unknown: the read is whole or nothing.
      expect(screen.getByTestId('alarm-sensors-away').textContent).not.toMatch(/Checking/)
      expect(screen.getByTestId('alarm-sensors-away').textContent).not.toMatch(/closed/i)
    })
  })
})

describe('NotificationAlarm — an answer from a hub older than D697 / D636 (review T9)', () => {
  const { modeDelays: _modeDelays, ...settingsWithoutModeDelays } = ALARM_CONFIG.settings
  const { nonBlocking: _nonBlocking, ...settingsWithoutNonBlocking } = ALARM_CONFIG.settings
  const WITHOUT_MODE_DELAYS: AlarmConfigOnTheWire = {
    ...ALARM_CONFIG,
    settings: settingsWithoutModeDelays,
  }
  const WITHOUT_NON_BLOCKING: AlarmConfigOnTheWire = {
    ...ALARM_CONFIG,
    settings: settingsWithoutNonBlocking,
  }

  beforeEach(() => {
    mockSetAlarmConfig.mockReset()
    mockGetAlarmConfig.mockReset()
  })
  afterEach(() => {
    mockGetAlarmConfig.mockReset()
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
    mockSetAlarmConfig.mockReset()
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(ALARM_CONFIG))
  })

  it('blurring a mode delay sends the edit and shows the not-landed banner (modeDelays ABSENT)', async () => {
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(WITHOUT_MODE_DELAYS))
    // The old hub strips the key it does not know: the answer still has no modeDelays.
    mockSetAlarmConfig.mockImplementation(() => Promise.resolve(WITHOUT_MODE_DELAYS))
    renderPage()
    const input = await screen.findByTestId('alarm-delay-away-exit')
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    await waitFor(() => expect(mockSetAlarmConfig).toHaveBeenCalledTimes(1))
    expect(mockSetAlarmConfig).toHaveBeenCalledWith({
      patch: { modeDelays: [{ mode: 'away', exitDelaySec: 60 }] },
    })
    const note = await screen.findByTestId('alarm-save-not-landed')
    expect(note.textContent).toMatch(/did not apply this change/)
  })

  it('renders the sensor rows when nonBlocking is ABSENT: nothing is non-blocking', async () => {
    mockGetAlarmConfig.mockImplementation(() => Promise.resolve(WITHOUT_NON_BLOCKING))
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    // Controllable (lock 42): Blocks defaults OFF. Contact (50): Blocks defaults ON.
    expect(switchOf('away', '42').getAttribute('aria-checked')).toBe('false')
    expect(switchOf('away', '50').getAttribute('aria-checked')).toBe('true')
  })
})

/** jsdom has no matchMedia; `DataTable` reads the phone breakpoint through `useIsMobile`. */
function setViewport(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('max-width: 767px'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('NotificationAlarm — the shared table, field and target components', () => {
  afterEach(() => {
    // Back to "no matchMedia": the desktop layout every other test in this file runs in.
    Reflect.deleteProperty(window, 'matchMedia')
    window.localStorage.clear()
  })

  it('the sensors are the shared device list: one table, Type and coverage hidden on a phone', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    const region = screen.getByTestId('alarm-sensors-away')
    expect(region.querySelectorAll('table').length).toBe(1)
    const headers = within(region).getAllByRole('columnheader')
    const header = (text: string): HTMLElement | undefined =>
      headers.find((th) => th.textContent === text)
    // Name, State and the switch are the phone's columns; the others only from `sm` up.
    expect(header('Type')?.className).toMatch(/\bhidden sm:table-cell\b/)
    expect(header('Checked when arming')?.className).toMatch(/\bhidden sm:table-cell\b/)
    expect(header('Name')?.className).not.toMatch(/\bhidden\b/)
    expect(header('State')?.className).not.toMatch(/\bhidden\b/)
    expect(header('Blocks arming')?.className).not.toMatch(/\bhidden\b/)
  })

  it('one list sorted by name, never split by zone or room; the zone is a line under the name', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    const region = screen.getByTestId('alarm-sensors-away')
    expect(within(region).queryByTestId('alarm-group-header')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Location' })).toBeNull()
    const names = within(region)
      .getAllByTestId('alarm-cell-name')
      .map((el) => el.firstElementChild?.textContent ?? '')
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)))
  })

  it('the modes are tabs with a count; one mode is shown at a time', async () => {
    renderPage()
    await waitFor(() => expect(rowIds('away')).toEqual(['42', '50']))
    expect(screen.getByTestId('alarm-tab-away').textContent).toContain('2')
    expect(screen.queryByTestId('alarm-sensors-home')).toBeNull()
    expect(rowIds('home')).toEqual(['77'])
    expect(screen.queryByTestId('alarm-sensors-away')).toBeNull()
  })

  it('a delay that would be refused on blur says why, and sends nothing', async () => {
    mockSetAlarmConfig.mockClear()
    renderPage()
    openMode('away')
    const input = await screen.findByTestId('alarm-delay-away-exit')
    fireEvent.change(input, { target: { value: '99999' } })
    expect(await screen.findByText(/whole number of seconds from 0 to/i)).toBeTruthy()
    fireEvent.blur(input)
    expect(mockSetAlarmConfig).not.toHaveBeenCalled()
    // The refusal stays after the blur — the box is back at the stored value, and a
    // message that vanished with the draft would leave a silently discarded entry.
    expect(screen.getByText(/99999 was not saved — Enter a whole number of seconds/i)).toBeTruthy()
    // ...until the next keystroke.
    fireEvent.change(input, { target: { value: '4' } })
    expect(screen.queryByText(/was not saved/i)).toBeNull()
  })

  it('an emptied delay is not flagged while typing, and is said to be unsaved on blur', async () => {
    mockSetAlarmConfig.mockClear()
    renderPage()
    openMode('away')
    const input = await screen.findByTestId('alarm-delay-away-exit')
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.queryByText(/whole number of seconds from 0 to/i)).toBeNull()
    fireEvent.blur(input)
    expect(mockSetAlarmConfig).not.toHaveBeenCalled()
    expect(
      screen.getByText(/Nothing was entered, so nothing was saved — Enter a whole number/i),
    ).toBeTruthy()
  })
})
