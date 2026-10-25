/**
 * Component tests for the Notification Rules page (slice D1).
 *
 * Mocks the live tRPC client behind `useSystem()` (mirrors NotificationTargets
 * / Capabilities page tests). Verifies: empty state, row rendering, the
 * enabled toggle + delete-confirm wiring, and that the create modal builds a
 * valid `NcRuleInput` (empty conditions, selected targets).
 */
import type {
  NcConditionDescriptor,
  NcRule,
  NcRuleLastRuns,
  NcSnooze,
  Target,
} from '@camstack/types'
import { NC_AUDIO_DB_OFFERED, NC_CONDITION_CATALOG } from '@camstack/types'
import type { System } from '@camstack/sdk'
import { ConfirmDialogProvider, SystemProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'
import { templateCatalogAnswer } from './template-catalog.fixture'

let mockRules: NcRule[] = []
let mockTargets: Target[] = []

const mockListRules = vi.fn(
  (): Promise<{ rules: readonly NcRule[] }> => Promise.resolve({ rules: mockRules }),
)
const mockListTargets = vi.fn((): Promise<readonly Target[]> => Promise.resolve(mockTargets))
const mockSetEnabled = vi.fn((_i: unknown) => Promise.resolve({ success: true as const }))
const mockDelete = vi.fn((_i: unknown) => Promise.resolve({ success: true as const }))
const mockCreate = vi.fn((i: { rule: unknown }) =>
  Promise.resolve({ rule: { ...(i.rule as object), id: 'new' } }),
)
const mockUpdate = vi.fn((i: { ruleId: string; patch: unknown }) =>
  Promise.resolve({ rule: { id: i.ruleId } }),
)
const mockCatalog = vi.fn(
  (): Promise<{ catalog: readonly NcConditionDescriptor[] }> =>
    Promise.resolve({ catalog: NC_CONDITION_CATALOG }),
)
const mockTestRule = vi.fn((_i: unknown) => Promise.resolve({ results: [] }))
const mockGetTemplateCatalog = vi.fn(() => Promise.resolve(templateCatalogAnswer()))
const mockPreviewTemplate = vi.fn((_i: unknown) => Promise.resolve({ title: null, body: null }))
/** The snooze half. `listSnoozes` is what the "Silenced right now" panel reads,
 *  and the wiring test asserts a create INVALIDATES it. */
const mockListSnoozes = vi.fn(
  (): Promise<{ snoozes: readonly NcSnooze[] }> => Promise.resolve({ snoozes: [] }),
)
const mockCreateSnooze = vi.fn((_i: unknown) =>
  Promise.resolve({
    snooze: {
      id: 's1',
      userId: 'admin',
      scope: 'rule' as const,
      ruleId: 'r1',
      startedAt: 0,
      expiresAt: 1,
      global: false,
      summary: true,
    },
  }),
)
const mockCancelSnooze = vi.fn((_i: unknown) => Promise.resolve({ success: true as const }))
/** The generic addon bridge — `nc.getRuleStatus` and `nc.testRule` ride it. */
/** Per-action answers for the producer lists (`nc.listSummaryRules`, …). Any
 *  other bridge action keeps answering the inert default. */
let mockBridgeAnswers: Readonly<Record<string, unknown>> = {}
function bridgeActionOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('action' in input)) return undefined
  return typeof input.action === 'string' ? input.action : undefined
}
const mockCustom = vi.fn((input: unknown): Promise<unknown> => {
  const action = bridgeActionOf(input)
  if (action !== undefined && action in mockBridgeAnswers) {
    return Promise.resolve(mockBridgeAnswers[action])
  }
  return Promise.resolve({ kind: 'none', reason: 'nothing' })
})
const mockListAll = vi.fn(() => Promise.resolve([]))
/** Which device ids carry the asked caps — the Devices tab's compatibility
 *  filter (operator ruling, 2026-10-01). Swapped per test. */
let mockCompatIds: readonly number[] = []
const mockListDeviceIdsByCaps = vi.fn((_i: { capNames: readonly string[] }) =>
  Promise.resolve(mockCompatIds),
)
/** The "Last run" column's ONE read. Swapped per test: answered, pending
 *  (never settles) or failed. */
const DAY_MS = 24 * 3_600_000
let mockLastRunsImpl: () => Promise<NcRuleLastRuns> = () =>
  Promise.resolve({ runs: [], horizonMs: 7 * DAY_MS })
const mockGetRuleLastRuns = vi.fn((_i: unknown) => mockLastRunsImpl())
// The system-event field's own catalogues: real node ids and real package
// names, so a rule cannot be narrowed to something that does not exist.
// The node list is the cheap `nodes.directory` (D315 — `nodes.topology` walks
// the cluster, 32–51 s); topology stays mocked only to prove nothing reads it.
const mockDirectory = vi.fn(() =>
  Promise.resolve({
    nodes: [{ id: 'hub', name: 'Hub', isHub: true, isOnline: true }],
    complete: true,
  }),
)
const mockTopology = vi.fn(() => Promise.resolve([{ id: 'hub', name: 'Hub', isOnline: true }]))
const mockListPackages = vi.fn(() =>
  Promise.resolve([{ name: '@camstack/addon-ai', version: '0.2.17' }]),
)
const mockListSequences = vi.fn(
  (): Promise<{ sequences: readonly unknown[] }> => Promise.resolve({ sequences: [] }),
)
const mockCreateSequence = vi.fn((i: { name: string; actions: unknown[] }) =>
  Promise.resolve({
    sequence: { id: 'seq-new', name: i.name, actions: i.actions, createdAt: 1, updatedAt: 1 },
  }),
)
const mockCreateSequenceMutate = {
  mutateAsync: mockCreateSequence,
  isPending: false,
}

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
  readonly onRetry?: () => void
}

/** What the shared fleet query answers in these tests. */
const FLEET_ROWS: readonly FleetRow[] = [
  { id: 101, name: 'Camera front door', type: 'camera', stableId: 'cam-101', location: null },
  {
    id: 42,
    name: 'Serratura front door',
    type: 'lock',
    stableId: 'lock-42',
    location: 'Front door',
  },
]

/** The generated fleet hook — the ONLY client these pages may read the fleet
 *  through. See `fleet-read-spy.ts` for what the assertion pins and why. */
const listAllHook = vi.fn(
  (_input?: FleetListInput, _options?: FleetListOptions): FleetListResult =>
    fleetListResult(FLEET_ROWS),
)

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useDeviceManagerListAll: (input?: FleetListInput, options?: FleetListOptions) =>
      listAllHook(input, options),
    // Every condition is on screen now (D690) — the face and plate pickers too.
    useFaceGalleryListIdentities: () => ({ data: [], isLoading: false, isError: false }),
    usePlateGalleryListPlates: () => ({ data: [], isLoading: false }),
    usePlateGalleryListVehicles: () => ({ data: [], isLoading: false }),
    useNotificationRulesListSequences: () => ({
      data: { sequences: [] },
      isLoading: false,
      isError: false,
      refetch: mockListSequences,
    }),
    useNotificationRulesCreateSequence: () => mockCreateSequenceMutate,
    // The calendar-events editor lists calendars through a tRPC React hook.
    useCalendarsListCalendars: () => ({ data: [], isPending: false, isError: false }),
    useSystem: () => ({
      trpcClient: {
        zones: { listZones: { query: () => Promise.resolve([]) } },
        pipelineAnalytics: { listEventKinds: { query: () => Promise.resolve([]) } },
        notificationRules: {
          listRules: { query: mockListRules },
          setRuleEnabled: { mutate: mockSetEnabled },
          deleteRule: { mutate: mockDelete },
          createRule: { mutate: mockCreate },
          updateRule: { mutate: mockUpdate },
          getConditionCatalog: { query: mockCatalog },
          testRule: { mutate: mockTestRule },
          listSnoozes: { query: mockListSnoozes },
          createSnooze: { mutate: mockCreateSnooze },
          cancelSnooze: { mutate: mockCancelSnooze },
          getTemplateCatalog: { query: mockGetTemplateCatalog },
          previewTemplate: { mutate: mockPreviewTemplate },
          getRuleLastRuns: { query: mockGetRuleLastRuns },
          listSequences: { query: mockListSequences },
          createSequence: { mutate: mockCreateSequence },
        },
        notificationOutput: {
          listTargets: { query: mockListTargets },
        },
        deviceManager: {
          listAll: { query: mockListAll },
          listDeviceIdsByCaps: { query: mockListDeviceIdsByCaps },
        },
        nodes: {
          topology: { query: mockTopology },
          directory: { query: mockDirectory },
        },
        addons: {
          listPackages: { query: mockListPackages },
          custom: { mutate: mockCustom },
        },
      },
    }),
    // The real field reads the target-kind catalogue through a tRPC React
    // provider this page never mounts in; the dialog's contract here is only
    // "pick targets by name", so a plain multi-select stands in for it.
    NotificationTargetsField: ({
      targets,
      value,
      onChange,
    }: {
      readonly targets: readonly { readonly id: string; readonly name: string }[]
      readonly value: readonly string[]
      readonly onChange: (next: string[]) => void
    }) => (
      <div data-testid="targets-field">
        {targets.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={value.includes(entry.id)}
            onClick={() =>
              onChange(
                value.includes(entry.id)
                  ? value.filter((id) => id !== entry.id)
                  : [...value, entry.id],
              )
            }
          >
            {entry.name}
          </button>
        ))}
      </div>
    ),
    ErrorBox: ({ title, message, onRetry }: ErrorBoxProps) => (
      <div data-testid="error-box">
        <span>{title}</span>
        <span>{message}</span>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    ),
  }
})

import { NotificationRulesPage, type NotificationRulesPageProps } from '../NotificationRules'

/** Open a rule the way the operator does: a click anywhere on its row (R2). */
function openRuleRow(name: string): void {
  fireEvent.click(screen.getByText(name))
}

/** All rules' create control opens a type-picker dialog — open it and pick a type. */
async function openNewRuleTypeFromAll(type: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('rules-new-menu')).toBeTruthy())
  fireEvent.click(screen.getByTestId('rules-new-menu'))
  await waitFor(() => expect(screen.getByTestId(`rules-new-${type}`)).toBeTruthy())
  fireEvent.click(screen.getByTestId(`rules-new-${type}`))
}

/** There is no generic "Rule" in the menu: an event rule starts as a Detection. */
async function openNewEventRuleFromAll(): Promise<void> {
  await openNewRuleTypeFromAll('detection')
  await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
}

/** Real DevicePicker closes over useSystem — mock export is not enough; provide context. */
function mockSystemForPicker(): System {
  return {
    trpcClient: {
      deviceManager: {
        listSiteZones: { query: () => Promise.resolve([]) },
        getBindings: { query: () => Promise.resolve({ entries: [] }) },
        listDeviceIdsByCaps: { query: mockListDeviceIdsByCaps },
      },
    },
  } as unknown as System
}

function renderPage(props: NotificationRulesPageProps = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SystemProvider system={mockSystemForPicker()}>
        <ConfirmDialogProvider>
          <MemoryRouter>
            <NotificationRulesPage {...props} />
          </MemoryRouter>
        </ConfirmDialogProvider>
      </SystemProvider>
    </QueryClientProvider>,
  )
}

function target(id: string, name: string): Target {
  return { id, name, kind: 'ntfy', addonId: 'notifiers', enabled: true, config: {} }
}

function rule(overrides: Partial<NcRule> = {}): NcRule {
  return {
    id: 'r1',
    name: 'Front door',
    enabled: true,
    disabledTargetIds: [],
    delivery: 'track-end',
    conditions: {},
    targets: [{ targetId: 't1' }],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/**
 * Reset EVERY mock and the fixture rows.
 *
 * Module-level rather than inline in one `beforeEach`: a second `describe` in
 * this file that forgot to call it inherited the previous block's rules and
 * call log, and the resulting failures pointed at the component instead of at
 * the harness.
 */
function resetHarness(): void {
  // jsdom does not implement <dialog>.showModal()/close(); stub them so the
  // Dialog primitive's open/close effect runs without throwing.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
  mockRules = []
  mockTargets = []
  mockBridgeAnswers = {}
  mockListRules.mockClear()
  mockListTargets.mockClear()
  mockCustom.mockClear()
  mockSetEnabled.mockClear()
  mockDelete.mockClear()
  mockCreate.mockClear()
  mockUpdate.mockClear()
  mockCatalog.mockClear()
  mockTestRule.mockClear()
  mockListAll.mockClear()
  mockTopology.mockClear()
  mockDirectory.mockClear()
  mockListPackages.mockClear()
  mockLastRunsImpl = () => Promise.resolve({ runs: [], horizonMs: 7 * DAY_MS })
  mockGetRuleLastRuns.mockClear()
  mockListSnoozes.mockReset()
  mockListSnoozes.mockImplementation(() => Promise.resolve({ snoozes: [] }))
  mockCreateSnooze.mockClear()
  mockCancelSnooze.mockClear()
  mockCompatIds = []
  mockListDeviceIdsByCaps.mockClear()
  // A test that swaps the implementation must not leak it into the next one.
  mockListDeviceIdsByCaps.mockImplementation((_i) => Promise.resolve(mockCompatIds))
  mockListSequences.mockClear()
  mockCreateSequence.mockClear()
  window.history.replaceState(null, '', window.location.pathname)
}

describe('NotificationRules page', () => {
  beforeEach(resetHarness)

  it('shows the empty state when there are no rules', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/No rules yet/i)).toBeTruthy())
  })

  it('renders a rule row with its trigger and target in their own columns', async () => {
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(screen.getByText(/Track end/)).toBeTruthy()
    // The table gives targets their own column, so a single target shows its
    // NAME rather than the old "1 target (Alerts)" prose.
    expect(screen.getByText('Alerts')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Targets' })).toBeTruthy()
  })

  it('toggles enabled and confirms before deleting', async () => {
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('toggle Front door'))
    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith({ ruleId: 'r1', enabled: false }),
    )

    // Delete is a two-step confirm through the shared confirm dialog.
    fireEvent.click(screen.getByTitle('Delete'))
    expect(mockDelete).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ ruleId: 'r1' }))
  })

  it('hands a row to the simulator, and renders no simulate button without one', async () => {
    mockRules = [rule()]
    const onSimulateRule = vi.fn()

    const withoutSimulator = renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    // A button that cannot hand off anywhere is not rendered at all — a button
    // that silently does nothing reads as a broken feature. `Test now` is a
    // DIFFERENT button and is always there: it needs no simulator, it fires the
    // rule through the hub.
    expect(screen.queryByLabelText('simulate Front door')).toBeNull()
    expect(screen.getByLabelText('test Front door now')).toBeTruthy()
    withoutSimulator.unmount()

    renderPage({ onSimulateRule })
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('simulate Front door'))
    expect(onSimulateRule).toHaveBeenCalledTimes(1)
    expect(onSimulateRule.mock.calls[0]![0]).toMatchObject({ id: 'r1' })
  })

  /**
   * THE SNOOZE WIRING — pinned because it did not exist.
   *
   * Operator report, 2026-08-14: a snooze pressed on a rule never appeared under
   * "Silenced right now", and the triage found ZERO server requests behind the
   * tap. Not a detached handler: this page had no `createSnooze` call site at
   * all, and what the operator pressed was the editor's `Snooze buttons`
   * palette, which authors the durations the NOTIFICATION offers.
   *
   * So the pin is the CALL, not the rendering: pressing the row's snooze must
   * reach `notificationRules.createSnooze` with a rule-scoped window, and must
   * then invalidate the key the panel reads — a window nobody can see is the
   * whole defect.
   */
  it('opens a REAL rule-scoped snooze from the row, and refreshes the silenced panel', async () => {
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(mockCreateSnooze).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('snooze Front door'))

    await waitFor(() => expect(mockCreateSnooze).toHaveBeenCalledTimes(1))
    expect(mockCreateSnooze.mock.calls[0]![0]).toEqual({
      snooze: { scope: 'rule', ruleId: 'r1', durationMinutes: 30 },
    })
    // The panel above the table reads `listSnoozes`; the invalidation is what
    // makes the window appear at once instead of up to 30 s later.
    await waitFor(() => expect(mockListSnoozes.mock.calls.length).toBeGreaterThan(1))
  })

  it('creates a rule with empty conditions and the chosen target', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openNewEventRuleFromAll()
    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Test rule' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByText('Create rule'))

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.name).toBe('Test rule')
    // The one condition a new detection rule carries: the pipeline source (R5).
    expect(arg.rule.conditions).toEqual({ source: 'pipeline' })
    expect(arg.rule.targets).toEqual([{ targetId: 't1' }])
    expect(arg.rule.delivery).toBe('immediate')
    // A create has no stored rule to empty: `clear` is an update-only key.
    expect('clear' in (mockCreate.mock.calls[0]![0] as object)).toBe(false)
  })
})

// ── System events section (2026-08-12) ──────────────────────────────

/**
 * The live "Eventi di sistema" rule (id 091937f1…), narrowed to its `system`
 * family half. The live rule also named `device-offline` / `device-online`,
 * which makes it `mixed` under D637 (listed under "To recreate", never edited);
 * this section lists the single-family rules its replacement is made of.
 */
function liveSystemRule(): NcRule {
  return rule({
    id: '091937f1-5299-418e-a72c-6edb52235c3d',
    name: 'Eventi di sistema',
    delivery: 'system-event',
    conditions: {
      systemEvent: {
        kinds: ['node-offline', 'node-online', 'addon-update-available', 'server-update-available'],
      },
    },
    targets: [{ targetId: 't1' }],
    media: { attach: 'none' },
    throttle: { cooldownSec: 600, scope: 'rule-device' },
  })
}

async function openSystemSection(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('tab', { name: /System events/ })).toBeTruthy())
  fireEvent.click(screen.getByRole('tab', { name: /System events/ }))
}

describe('the System events section', () => {
  beforeEach(resetHarness)

  it('splits the list into sections and counts each one', async () => {
    mockRules = [liveSystemRule(), rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Eventi di sistema')).toBeTruthy())

    // All rules first, and it really holds everything.
    expect(screen.getByRole('tab', { name: /All rules/ }).textContent).toContain('2')
    expect(screen.getByRole('tab', { name: /Detections/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /System events/ }).textContent).toContain('1')
  })

  it('shows the system rule ONLY in its own section, with system columns', async () => {
    mockRules = [liveSystemRule(), rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSystemSection()

    // The detection rule is gone; the system rule is there.
    await waitFor(() => expect(screen.queryByText('Front door')).toBeNull())
    expect(screen.getByText('Eventi di sistema')).toBeTruthy()

    // Its own columns: which events, how narrowly, how often. A "Trigger"
    // column reading "System event" on every row answers nothing.
    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Scope' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Cooldown' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Trigger' })).toBeNull()

    // The live rule's own values, read back.
    expect(screen.getByText('Node offline, Node online +2')).toBeTruthy()
    expect(screen.getByText('Everything')).toBeTruthy()
    expect(screen.getByText('10 minutes')).toBeTruthy()
  })

  it('opens a NEW rule on the system trigger when started from the section', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSystemSection()

    fireEvent.click(screen.getByText('New system rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())

    // The trigger select now HAS the option, and shows it selected.
    const trigger = screen.getByDisplayValue('System event')
    expect(trigger).toBeTruthy()
    // The Devices tab is dropped — `conditions.devices` is not evaluated for
    // this trigger, so a tab that authored it would be a lie.
    expect(screen.queryByRole('tab', { name: 'Devices' })).toBeNull()
    // D637: the conditions tab is named after the family the seed authors.
    expect(screen.getByRole('tab', { name: 'System events' })).toBeTruthy()
  })

  it('authors a system rule: kinds selected, no media, no devices key', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSystemSection()

    fireEvent.click(screen.getByText('New system rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Eventi di sistema' },
    })
    fireEvent.click(screen.getByText('Alerts'))

    // D637: the seed already names its family's kinds — the kind is derived
    // from them, so an empty seed would open a `mixed` rule.
    fireEvent.click(screen.getByRole('tab', { name: 'System events' }))
    await waitFor(() => expect(screen.getByTestId('system-event-field')).toBeTruthy())
    expect(screen.getByText('Create rule').closest('button')?.disabled).toBe(false)

    // The LAST kinds cannot be unticked (D637): a rule with no kinds is
    // `mixed`, and the hub's `kinds.min(1)` refuses it anyway. The node pair
    // is ONE class checkbox (D906).
    const nodes = 'Node connectivity (offline / back online)'
    fireEvent.click(screen.getByRole('checkbox', { name: nodes }))
    expect(screen.getByRole('checkbox', { name: nodes }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Create rule').closest('button')?.disabled).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Backup completed' }))
    fireEvent.click(screen.getByRole('checkbox', { name: nodes }))
    fireEvent.click(screen.getByRole('checkbox', { name: nodes }))

    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('system-event')
    // Ticking the class saves BOTH edges.
    expect(arg.rule.conditions.systemEvent).toEqual({
      kinds: ['node-offline', 'node-online', 'backup-completed'],
    })
    expect(mockDirectory).toHaveBeenCalled()
    expect(mockTopology).not.toHaveBeenCalled()
    // No frame behind "a node went offline" — same value the viewer writes.
    expect(arg.rule.media).toEqual({ image: 'none' })
    expect(arg.rule.conditions.devices).toBeUndefined()
  })

  it('switching the trigger to system-event from All picks a family — never a mixed rule', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openNewEventRuleFromAll()
    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Switched' },
    })
    fireEvent.click(screen.getByText('Alerts'))

    fireEvent.change(screen.getByDisplayValue('Immediate'), { target: { value: 'system-event' } })
    // A family, seeded — the conditions tab is named after it, not "To recreate".
    const family = screen.getByLabelText('Kind of system rule')
    if (!(family instanceof HTMLSelectElement)) throw new Error('not a select')
    expect(family.value).toBe('device-events')
    expect(screen.getByRole('tab', { name: 'Device events' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'To recreate' })).toBeNull()

    // Picking another family re-seeds its kinds.
    fireEvent.change(family, { target: { value: 'alarm' } })
    expect(screen.getByRole('tab', { name: 'Alarm' })).toBeTruthy()

    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('system-event')
    expect(arg.rule.conditions.systemEvent).toEqual({ kinds: ['alarm-triggered'] })
  })

  it('edits the live rule without touching what it already says', async () => {
    mockRules = [liveSystemRule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSystemSection()
    await waitFor(() => expect(screen.getByText('Eventi di sistema')).toBeTruthy())

    openRuleRow('Eventi di sistema')
    await waitFor(() => expect(screen.getByText('Edit Eventi di sistema')).toBeTruthy())
    // THE DEFECT THIS CLOSES: before the system-event option existed, this
    // select displayed "Immediate" and the next change event rewrote the rule.
    expect(screen.getByDisplayValue('System event')).toBeTruthy()
    // D637: a saved rule's family is fixed — only a NEW rule picks one.
    expect(screen.queryByLabelText('Kind of system rule')).toBeNull()

    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    const arg = mockUpdate.mock.calls[0]![0] as { ruleId: string; patch: NcRule }
    expect(arg.ruleId).toBe('091937f1-5299-418e-a72c-6edb52235c3d')
    expect(arg.patch.delivery).toBe('system-event')
    expect(arg.patch.conditions.systemEvent).toEqual(liveSystemRule().conditions.systemEvent)
    expect(arg.patch.throttle).toEqual({ cooldownSec: 600, scope: 'rule-device' })
    expect(arg.patch.media).toEqual({ image: 'none' })
    // Nothing the rule already says may be named for removal.
    const carried = Object.keys(liveSystemRule())
    const cleared = (mockUpdate.mock.calls[0]![0] as { clear?: readonly string[] }).clear ?? []
    expect(cleared.filter((key) => carried.includes(key))).toEqual([])
  })
})

// ── Family sections and "To recreate" (D637) ────────────────────────

/** The live rule as it is stored today: device AND system kinds — `mixed`. */
function mixedRule(): NcRule {
  return rule({
    id: 'mixed-1',
    name: 'Old catch-all',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-offline', 'node-offline'] } },
    media: { attach: 'none' },
  })
}

describe('D637 — family sections and the rules to recreate', () => {
  beforeEach(resetHarness)

  it('lists Device events, System events and Alarm — and no "To recreate" while it is empty', async () => {
    mockRules = [liveSystemRule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Eventi di sistema')).toBeTruthy())
    expect(screen.getByRole('tab', { name: /Device events/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /System events/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Alarm/ })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /To recreate/ })).toBeNull()
  })

  it('gives a family section the system columns and its own create button', async () => {
    mockRules = [
      rule({
        id: 'dev-1',
        name: 'Cameras down',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['device-offline'] } },
        media: { attach: 'none' },
      }),
      liveSystemRule(),
    ]
    renderPage()
    await waitFor(() => expect(screen.getByText('Cameras down')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: /Device events/ }))
    await waitFor(() => expect(screen.queryByText('Eventi di sistema')).toBeNull())
    expect(screen.getByText('Cameras down')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeTruthy()
    expect(screen.queryByRole('columnheader', { name: 'Trigger' })).toBeNull()
    expect(screen.getByText('New device-event rule')).toBeTruthy()
  })

  it('lists a mixed rule under "To recreate": switch it off or delete it, never edit it', async () => {
    mockRules = [mixedRule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByRole('tab', { name: /To recreate/ })).toBeTruthy())
    expect(screen.getByRole('tab', { name: /To recreate/ }).textContent).toContain('1')
    fireEvent.click(screen.getByRole('tab', { name: /To recreate/ }))
    await waitFor(() => expect(screen.getByText('Old catch-all')).toBeTruthy())

    // Nothing is created from here.
    expect(screen.queryByRole('button', { name: /New rule/ })).toBeNull()
    // The system columns, read-only.
    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeTruthy()
    const badge = screen.getByText('Recreate as one rule per family')
    expect(badge.closest('[title]')?.getAttribute('title')).toContain('one rule per family')
    // No way into the editor: its buildConditions would rewrite the rule.
    openRuleRow('Old catch-all')
    expect(screen.queryByText('Edit Old catch-all')).toBeNull()
    expect(screen.queryByTitle('Duplicate')).toBeNull()

    // Switching it off is allowed — the step before deleting it.
    fireEvent.click(screen.getByLabelText('toggle Old catch-all'))
    await waitFor(() =>
      expect(mockSetEnabled).toHaveBeenCalledWith({ ruleId: 'mixed-1', enabled: false }),
    )
    fireEvent.click(screen.getByTitle('Delete'))
    const mixedDialog = await screen.findByRole('dialog')
    fireEvent.click(within(mixedDialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith({ ruleId: 'mixed-1' }))
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(screen.queryByText(/^Edit /)).toBeNull()
  })

  it('never opens the editor on a mixed rule from the All list either', async () => {
    mockRules = [mixedRule(), rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Old catch-all')).toBeTruthy())
    // Only the detection rule's row opens.
    openRuleRow('Old catch-all')
    expect(screen.queryByText('Edit Old catch-all')).toBeNull()
    openRuleRow('Front door')
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
  })
})

// ── What a save clears (D628) ───────────────────────────────────────

/** A rule carrying every field the admin editor authors AND may clear. */
function fullyAuthoredRule(): NcRule {
  return rule({
    delivery: 'immediate',
    groupingSec: 20,
    template: { title: 'Somebody at the door', body: 'Seen at {{time}}' },
    schedule: { windows: [{ days: [1, 2, 3], startMinute: 480, endMinute: 1080 }] },
    targetUsers: ['user-bob'],
    snoozeOptions: [10, 30],
    snoozeAllowGlobal: true,
    actions: {
      onTrigger: [{ kind: 'do', action: { kind: 'wait', seconds: 1 } }],
    },
  })
}

interface UpdateArg {
  readonly ruleId: string
  readonly patch: NcRule
  readonly clear?: readonly string[]
}

async function saveEditedRule(edit?: () => Promise<void>): Promise<UpdateArg> {
  mockTargets = [target('t1', 'Alerts')]
  renderPage()
  await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
  openRuleRow('Front door')
  await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
  if (edit) await edit()
  fireEvent.click(screen.getByText('Save changes'))
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
  return mockUpdate.mock.calls[0]![0] as UpdateArg
}

describe('what a save clears', () => {
  beforeEach(resetHarness)

  it('sends no clear key at all when the form empties nothing', async () => {
    mockRules = [fullyAuthoredRule()]
    const arg = await saveEditedRule()
    // Old wire shape: a save that clears nothing carries no `clear` key.
    expect('clear' in arg).toBe(false)
    expect(arg.patch.template).toEqual({ title: 'Somebody at the door', body: 'Seen at {{time}}' })
  })

  it('names an emptied template in clear, and leaves it out of the patch', async () => {
    mockRules = [fullyAuthoredRule()]
    const arg = await saveEditedRule(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))
      await waitFor(() => expect(screen.getByDisplayValue('Somebody at the door')).toBeTruthy())
      fireEvent.change(screen.getByDisplayValue('Somebody at the door'), { target: { value: '' } })
      fireEvent.change(screen.getByDisplayValue('Seen at {{time}}'), { target: { value: '' } })
    })
    expect(arg.clear).toEqual(['template'])
    expect(arg.patch.template).toBeUndefined()
  })
})

describe('the scope pre-selectors, wired into the dialog (D641)', () => {
  beforeEach(resetHarness)

  it('opens a rule that excludes a device on "All except these", and saves the exclusion', async () => {
    mockRules = [rule({ conditions: { devicesExclude: [101], classesExclude: ['cat'] } })]
    const arg = await saveEditedRule(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Devices' }))
      const except = await screen.findByRole('radio', { name: 'All except these' })
      expect(except.getAttribute('aria-checked')).toBe('true')
      // Offered because the hub serves it — not only because the rule has it.
      fireEvent.click(screen.getByRole('radio', { name: 'All' }))
      expect(screen.getByRole('radio', { name: 'All except these' })).toBeTruthy()
      fireEvent.click(screen.getByRole('radio', { name: 'All except these' }))
      fireEvent.click(screen.getByRole('tab', { name: 'Conditions' }))
      const classes = await screen.findByRole('radiogroup', { name: 'Which classes' })
      expect(
        within(classes)
          .getByRole('radio', { name: 'All except these' })
          .getAttribute('aria-checked'),
      ).toBe('true')
    })
    expect(arg.patch.conditions).toEqual({ devicesExclude: [101], classesExclude: ['cat'] })
  })

  it('switching the class scope to All clears it on save', async () => {
    mockRules = [rule({ conditions: { classes: ['person'] } })]
    const arg = await saveEditedRule(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Conditions' }))
      const classes = await screen.findByRole('radiogroup', { name: 'Which classes' })
      fireEvent.click(within(classes).getByRole('radio', { name: 'All' }))
    })
    expect(arg.patch.conditions.classes).toBeUndefined()
  })
})

describe('a trigger this build does not recognise', () => {
  beforeEach(resetHarness)

  /**
   * DOCUMENTED TYPE BOUNDARY: the scenario is a hub NEWER than this bundle —
   * a delivery the local enum cannot express. Staging it requires stepping
   * outside the enum, and staging it is the point: this is the shape that
   * silently rewrote a live rule.
   */
  function futureRule(): NcRule {
    return rule({
      id: 'r9',
      name: 'From the future',
      delivery: 'quantum-event' as NcRule['delivery'],
    })
  }

  it('renders the rule read-only with a notice instead of an editable form', async () => {
    mockRules = [futureRule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('From the future')).toBeTruthy())
    // Said in the LIST too — the operator learns it before clicking.
    expect(screen.getAllByText('read-only').length).toBeGreaterThan(0)

    openRuleRow('From the future')
    await waitFor(() => expect(screen.getByTestId('unsupported-trigger-notice')).toBeTruthy())

    // Nothing that could write: no trigger select, no save.
    expect(screen.queryByText('Save changes')).toBeNull()
    expect(screen.queryByText('Create rule')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Conditions' })).toBeNull()
    // The rule is shown AS STORED.
    expect(screen.getAllByText('quantum-event').length).toBeGreaterThan(0)
  })

  it('never sends an update for it — closing the dialog writes nothing', async () => {
    mockRules = [futureRule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('From the future')).toBeTruthy())
    openRuleRow('From the future')
    await waitFor(() => expect(screen.getByTestId('unsupported-trigger-notice')).toBeTruthy())
    // ItemFormDialog dismisses via Dialog Close (X) — no second Cancel in the header.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ── Sound and Occupancy sections (2026-08-13) ───────────────────────
//
// Operator report: "non vedo sulla admin ui un modo per creare le nuove rules
// audio e occupancy" [I do not see in the admin UI a way to create the new audio and occupancy rules]. Both engines had shipped and both conditions were
// authorable — behind "Show more configurations", on a trigger the operator had
// to know to pick first. Neither has a delivery of its own, so neither had a
// section, a button or a word anywhere on the page.

/** The live audio rule (4d7dbe2a…), as the hub returns it. */
function liveAudioRule(): NcRule {
  return rule({
    id: '4d7dbe2a-0000-4000-8000-000000000001',
    name: 'Cane che abbaia',
    delivery: 'immediate',
    conditions: { audio: { labels: ['dog'], hitPercent: 60, samplingSeconds: 10 } },
  })
}

/** The live occupancy rule ("Pat è andato via / tornato" [Dad has gone away / is back]). */
function liveOccupancyRule(): NcRule {
  return rule({
    id: '0c3a1f00-0000-4000-8000-000000000002',
    name: 'Pat è tornato',
    delivery: 'device-event',
    conditions: {
      devices: [102],
      occupancy: { op: 'became-occupied', count: 1, sustainSeconds: 15 },
    },
  })
}

async function openSection(name: RegExp): Promise<void> {
  await waitFor(() => expect(screen.getByRole('tab', { name })).toBeTruthy())
  fireEvent.click(screen.getByRole('tab', { name }))
}

describe('the Sound and Occupancy sections', () => {
  beforeEach(resetHarness)

  it('gives each kind its own section, counted by the CONDITION not the trigger', async () => {
    mockRules = [liveAudioRule(), liveOccupancyRule(), rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Cane che abbaia')).toBeTruthy())

    expect(screen.getByRole('tab', { name: /All rules/ }).textContent).toContain('3')
    // The audio rule is `immediate` and the occupancy rule is `device-event`:
    // a section keyed on delivery would have put both in Detections.
    expect(screen.getByRole('tab', { name: /Sound/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /Occupancy/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /Detections/ }).textContent).toContain('1')
  })

  it('creates a SOUND rule from the section, pre-seeded so it can fire', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Sound/)

    fireEvent.click(screen.getByText('New sound rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    // The trigger a sound rule rides, chosen for the operator.
    expect(screen.getByDisplayValue('Immediate')).toBeTruthy()
    // And the tab is NAMED for it — this is the word the operator was looking
    // for and could not find anywhere on the page.
    expect(screen.getByRole('tab', { name: 'Sound' })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Cane che abbaia' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('immediate')
    // The condition IS the rule: without it the engine never routes a sampling
    // window here. Seeded with a level, so the saved rule is not the shape
    // `matchesAudio` refuses.
    //
    // RE-ANCHORED, D460: the literal -55 here went red when the offered seed
    // moved to -43. What this test is for is that the section seeds A LEVEL at
    // all — the specific number belongs to the one constant that derives it.
    expect(arg.rule.conditions.audio).toEqual({
      hitPercent: 60,
      samplingSeconds: 10,
      dbThreshold: NC_AUDIO_DB_OFFERED,
    })
  })

  it('shows the sound editor WITHOUT expanding anything, and blocks the rule that can never fire', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Sound/)
    fireEvent.click(screen.getByText('New sound rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    // Everything else a rule needs first, so the ONLY thing left blocking Save
    // is the condition itself.
    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Silenzio' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByRole('tab', { name: 'Sound' }))

    await waitFor(() => expect(screen.getByTestId('condition-audio')).toBeTruthy())

    // Switch to SOUNDS without naming one: the seeded level goes (the modes
    // are exclusive) and the rule now names neither filter, which the engine
    // refuses — Create reveals why, and does not save.
    fireEvent.click(screen.getByRole('button', { name: /Sounds/i }))
    expect(screen.queryByTestId('rule-form-problems')).toBeNull()
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(screen.getByTestId('rule-form-problems')).toBeTruthy())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates an OCCUPANCY rule on the trigger its edges ride', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Occupancy/)

    fireEvent.click(screen.getByText('New occupancy rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    expect(screen.getByDisplayValue('Device event')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Occupancy' })).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Vialetto occupato' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('device-event')
    expect(arg.rule.conditions.occupancy).toEqual({
      op: 'became-occupied',
      count: 1,
      sustainSeconds: 15,
    })
  })

  it('an occupancy rule offers {{count}}; a detection rule does not', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Occupancy/)
    fireEvent.click(screen.getByText('New occupancy rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))
    expect(await screen.findByTestId('rule-template-title-chip-count')).toBeTruthy()
  })

  it('a plain detection rule never offers {{count}} — the catalog gates it to occupancy/system', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openNewEventRuleFromAll()
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))
    await waitFor(() => expect(screen.getByTestId('rule-template-title-input')).toBeTruthy())
    expect(screen.queryByTestId('rule-template-title-chip-count')).toBeNull()
  })

  it('opens an EXISTING sound rule on its own editor, unchanged by a save', async () => {
    mockRules = [liveAudioRule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Sound/)
    await waitFor(() => expect(screen.getByText('Cane che abbaia')).toBeTruthy())

    openRuleRow('Cane che abbaia')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Sound' })).toBeTruthy())
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))

    const arg = mockUpdate.mock.calls[0]![0] as { ruleId: string; patch: NcRule }
    // Byte-identical to what the API authored: opening an editor must never
    // rewrite the rule it is showing.
    expect(arg.patch.conditions.audio).toEqual({
      labels: ['dog'],
      hitPercent: 60,
      samplingSeconds: 10,
    })
  })
})

describe('the Sensors section — its own kind, not folded into Detections (operator ruling, 2026-10-01)', () => {
  beforeEach(resetHarness)

  it('creates a SENSOR rule from the section, with no occupancy condition', async () => {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Sensors/)

    fireEvent.click(screen.getByText('New sensor rule'))
    await waitFor(() => expect(screen.getByText('New notification rule')).toBeTruthy())
    // Same trigger as occupancy (`device-event`) — the CONDITION is what
    // tells them apart, and a sensor seed carries none.
    expect(screen.getByDisplayValue('Device event')).toBeTruthy()
    expect(screen.queryByTestId('condition-occupancy')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Campanello' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))

    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('device-event')
    expect(arg.rule.conditions.occupancy).toBeUndefined()
  })

  it('counts a sensor rule in Sensors, never in Detections or Occupancy', async () => {
    mockRules = [
      rule({ id: 'r-sensor', name: 'Campanello', delivery: 'device-event', conditions: {} }),
      rule(),
    ]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(screen.getByRole('tab', { name: /Sensors/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /Detections/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /Occupancy/ }).textContent).toContain('0')

    await openSection(/Sensors/)
    await waitFor(() => expect(screen.getByText('Campanello')).toBeTruthy())
    expect(screen.queryByText('Front door')).toBeNull()
  })
})

describe('the Devices tab is narrowed to what the rule KIND can use (operator ruling, 2026-10-01)', () => {
  beforeEach(resetHarness)

  it('a detection rule offers the pipeline-capable camera, not the lock', async () => {
    mockCompatIds = [101]
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Only these' }))

    await waitFor(() =>
      expect(mockListDeviceIdsByCaps).toHaveBeenCalledWith({ capNames: ['detection-pipeline'] }),
    )
    expect(await screen.findByText('Camera front door')).toBeTruthy()
    expect(screen.queryByText('Serratura front door')).toBeNull()
  })

  it('a sensor rule asks for the sensor/control caps AND the camera cap — a camera-scoped sensor rule is legitimate (D630 §6)', async () => {
    mockListDeviceIdsByCaps.mockImplementation((input) =>
      Promise.resolve(input.capNames.includes('camera-streams') ? [101] : [42]),
    )
    mockRules = [rule({ delivery: 'device-event', conditions: {} })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Only these' }))

    await waitFor(() => expect(mockListDeviceIdsByCaps).toHaveBeenCalledTimes(2))
    const asked = mockListDeviceIdsByCaps.mock.calls.map((call) => call[0].capNames)
    const sensorQuery = asked.find((caps) => caps.includes('contact'))
    expect(sensorQuery).toContain('doorbell')
    expect(sensorQuery).not.toContain('detection-pipeline')
    expect(asked).toContainEqual(['camera-streams'])
    expect(await screen.findByText('Serratura front door')).toBeTruthy()
    expect(await screen.findByText('Camera front door')).toBeTruthy()
  })

  it('a FAILED read says the list could not be checked — and still shows every device', async () => {
    mockListDeviceIdsByCaps.mockImplementation(() => Promise.reject(new Error('unreachable')))
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Only these' }))

    expect(await screen.findByTestId('rule-devices-compat-failed')).toBeTruthy()
    expect(screen.getByText('Camera front door')).toBeTruthy()
    expect(screen.getByText('Serratura front door')).toBeTruthy()
  })

  it('a device already selected is never dropped from the list, even when incompatible (D49)', async () => {
    mockCompatIds = [101]
    // The lock (42) is selected on a DETECTION rule — incompatible, but a
    // stored rule must still show (and let the operator remove) what it has.
    mockRules = [rule({ conditions: { devices: [42] } })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices' }))

    await waitFor(() => expect(mockListDeviceIdsByCaps).toHaveBeenCalled())
    // The chip AND the list row both name it — present at all is the point.
    await waitFor(() =>
      expect(screen.getAllByText('Serratura front door').length).toBeGreaterThan(0),
    )
  })

  it('shows a loading note while the read is pending — never "no devices" (D315)', async () => {
    let settle: (ids: readonly number[]) => void = () => {}
    mockListDeviceIdsByCaps.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (ids: readonly number[]) => void)),
    )
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    fireEvent.click(await screen.findByRole('tab', { name: 'Devices' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Only these' }))

    expect(await screen.findByTestId('rule-devices-compat-loading')).toBeTruthy()
    // Still shows every device while pending — a filter that cannot answer
    // yet must never read as "this rule has no devices".
    expect(screen.getByText('Camera front door')).toBeTruthy()
    expect(screen.getByText('Serratura front door')).toBeTruthy()

    settle([101])
    await waitFor(() => expect(screen.queryByTestId('rule-devices-compat-loading')).toBeNull())
  })
})

describe('a rule whose only device was deleted', () => {
  beforeEach(resetHarness)

  it('shows it removed on the Devices tab, and the widening warning survives a tab switch', async () => {
    // 102 is not in FLEET_ROWS: the answered fleet says it is gone.
    mockRules = [liveOccupancyRule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openSection(/Occupancy/)
    await waitFor(() => expect(screen.getByText('Pat è tornato')).toBeTruthy())
    openRuleRow('Pat è tornato')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Devices' })).toBeTruthy())

    fireEvent.click(screen.getByRole('tab', { name: 'Devices' }))
    const removed = await screen.findByText('Device #102 — removed')
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
    expect(removed).toBeTruthy()
    // The selection is chips (D636): the removed one is removed by its ✕.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Device #102 — removed' }))
    expect(screen.getByTestId('devices-widen-warning')).toBeTruthy()

    // A tab switch UNMOUNTS the Devices tab; the warning comes back from the
    // rule as opened, not from the unmounted picker's memory.
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
    expect(screen.queryByTestId('devices-widen-warning')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Devices' }))
    expect(await screen.findByTestId('devices-widen-warning')).toBeTruthy()
    expect(screen.queryByText('Device #102 — removed')).toBeNull()
  })
})

describe('the fleet read', () => {
  it('goes through the shared client, slim, and never through the raw tRPC client', () => {
    listAllHook.mockClear()
    mockListAll.mockClear()
    renderPage()
    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      expect(input?.projection).toBe('slim')
      // D274 owns the window on the query client; a call site that redeclares
      // it fails `scripts/check-fleet-query-defaults.ts`.
      expect(options?.staleTime).toBeUndefined()
    }
    // The raw client is the hole D274 does not close: a fleet read there rides
    // no shared window, no shared cache entry and no `[['deviceManager']]`
    // invalidation, so a rename never reaches this picker.
    expect(mockListAll).not.toHaveBeenCalled()
  })
})

// ── Linked cameras (ADR 0632) ───────────────────────────────────────

describe('the linked-cameras option on a sensor rule', () => {
  beforeEach(resetHarness)

  it('a sensor rule offers it and a save writes the choice', async () => {
    mockRules = [rule({ name: 'Porta front door', delivery: 'device-event' })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Porta front door')).toBeTruthy())
    openRuleRow('Porta front door')
    await waitFor(() => expect(screen.getByText('Edit Porta front door')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))

    const select = await screen.findByTestId('rule-media-linked-cameras')
    fireEvent.change(select, { target: { value: 'each' } })
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    const arg = mockUpdate.mock.calls[0]![0] as { patch: NcRule }
    expect(arg.patch.media.linkedCameras).toBe('each')
  })

  it("a sensor rule with a STORED attach:'none' still offers it — the server attaches one snapshot anyway (M3)", async () => {
    mockRules = [
      rule({ name: 'Porta front door', delivery: 'device-event', media: { attach: 'none' } }),
    ]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Porta front door')).toBeTruthy())
    openRuleRow('Porta front door')
    await waitFor(() => expect(screen.getByText('Edit Porta front door')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))

    expect(await screen.findByTestId('rule-media-linked-cameras')).toBeTruthy()
  })

  it('a detection rule does not offer it', async () => {
    mockRules = [rule({ name: 'Vialetto' })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Vialetto')).toBeTruthy())
    openRuleRow('Vialetto')
    await waitFor(() => expect(screen.getByText('Edit Vialetto')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))
    await waitFor(() => expect(screen.getByTestId('rule-template-title-input')).toBeTruthy())
    expect(screen.queryByTestId('rule-media-linked-cameras')).toBeNull()
  })
})

describe('ONE picture selector for every kind that carries media (D897)', () => {
  beforeEach(resetHarness)

  async function openNotificationTab(name: string): Promise<void> {
    renderPage()
    await waitFor(() => expect(screen.getByText(name)).toBeTruthy())
    openRuleRow(name)
    await waitFor(() => expect(screen.getByText(`Edit ${name}`)).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Notification' }))
  }

  function optionValues(select: HTMLElement): readonly string[] {
    return [...select.querySelectorAll('option')].map((o) => o.getAttribute('value') ?? '')
  }

  it('a SENSOR rule gets the selector, the footage controls and the linked-cameras picker', async () => {
    mockRules = [rule({ name: 'Porta front door', delivery: 'device-event' })]
    mockTargets = [target('t1', 'Alerts')]
    await openNotificationTab('Porta front door')
    const select = await screen.findByTestId('rule-media-image')
    expect(optionValues(select)).toEqual(['scene-boxes', 'crop', 'clean', 'none'])
    // A sensor rule stored before D897 shipped one clean snapshot: that is what it reads as.
    expect((select as HTMLSelectElement).value).toBe('clean')
    expect(screen.getByText('Attach a GIF around the event')).toBeTruthy()
    expect(screen.getByTestId('rule-media-linked-cameras')).toBeTruthy()
    expect(screen.queryByText('Media attachment')).toBeNull()
    expect(screen.queryByText('Image frame')).toBeNull()
  })

  it('offers the trigger-zone flag on a ZONE rule, saves it, and hides it on a crop', async () => {
    mockRules = [
      rule({
        name: 'Uscio',
        delivery: 'immediate',
        conditions: { classes: ['person'], zones: { ids: ['zone-uscio'] } },
        media: { image: 'scene-boxes' },
      }),
    ]
    mockTargets = [target('t1', 'Alerts')]
    await openNotificationTab('Uscio')
    expect(await screen.findByTestId('rule-media-show-trigger-zone')).toBeTruthy()
    fireEvent.change(screen.getByTestId('rule-media-image'), { target: { value: 'crop' } })
    expect(screen.queryByTestId('rule-media-show-trigger-zone')).toBeNull()
    fireEvent.change(screen.getByTestId('rule-media-image'), { target: { value: 'scene-boxes' } })
    fireEvent.click(screen.getByTestId('rule-media-show-trigger-zone'))
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    const arg = mockUpdate.mock.calls[0]![0] as { patch: NcRule }
    expect(arg.patch.media).toMatchObject({ image: 'scene-boxes', showTriggerZone: true })
  })

  it('a rule whose trigger is not a zone is never offered the flag', async () => {
    mockRules = [rule({ name: 'Vialetto', delivery: 'immediate', media: { image: 'clean' } })]
    mockTargets = [target('t1', 'Alerts')]
    await openNotificationTab('Vialetto')
    expect(await screen.findByTestId('rule-media-image')).toBeTruthy()
    expect(screen.queryByTestId('rule-media-show-trigger-zone')).toBeNull()
  })

  it('offers the subject-path flag (OFF by default) on a crop too, saves it, and hides it with no picture (D903)', async () => {
    mockRules = [rule({ name: 'Vialetto', delivery: 'immediate', media: { image: 'crop' } })]
    mockTargets = [target('t1', 'Alerts')]
    await openNotificationTab('Vialetto')
    const flag = (await screen.findByTestId('rule-media-show-subject-path')) as HTMLInputElement
    expect(flag.checked).toBe(false)
    fireEvent.change(screen.getByTestId('rule-media-image'), { target: { value: 'none' } })
    expect(screen.queryByTestId('rule-media-show-subject-path')).toBeNull()
    fireEvent.change(screen.getByTestId('rule-media-image'), { target: { value: 'crop' } })
    fireEvent.click(screen.getByTestId('rule-media-show-subject-path'))
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    const arg = mockUpdate.mock.calls[0]![0] as { patch: NcRule }
    expect(arg.patch.media).toMatchObject({ image: 'crop', showSubjectPath: true })
  })

  it('a stored subject-path flag loads checked', async () => {
    mockRules = [
      rule({
        name: 'Vialetto',
        delivery: 'immediate',
        media: { image: 'scene-boxes', showSubjectPath: true },
      }),
    ]
    mockTargets = [target('t1', 'Alerts')]
    await openNotificationTab('Vialetto')
    const flag = (await screen.findByTestId('rule-media-show-subject-path')) as HTMLInputElement
    expect(flag.checked).toBe(true)
  })
})

// ── Last run + History (the rule's own delivery record) ─────────────

describe('the Last run column (D315)', () => {
  beforeEach(resetHarness)

  it('asks ONCE for every rule — never a read per row', async () => {
    mockRules = [rule(), rule({ id: 'r2', name: 'Garage' })]
    renderPage()
    await waitFor(() => expect(screen.getByText('Garage')).toBeTruthy())
    expect(mockGetRuleLastRuns).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('columnheader', { name: 'Last run' })).toBeTruthy()
  })

  it('answered and absent: names the window the HUB answered with', async () => {
    mockRules = [rule()]
    mockLastRunsImpl = () => Promise.resolve({ runs: [], horizonMs: 3 * DAY_MS })
    renderPage()
    await waitFor(() => expect(screen.getByText('Not in the last 3 days')).toBeTruthy())
  })

  it('pending: a blank placeholder, never "not in the last …"', async () => {
    mockRules = [rule()]
    mockLastRunsImpl = () => new Promise<NcRuleLastRuns>(() => {})
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(screen.getByTestId('rule-last-run-pending')).toBeTruthy()
    expect(screen.queryByText(/Not in the last/)).toBeNull()
  })

  it('failed: "—" with the reason on hover, never "not in the last …"', async () => {
    mockRules = [rule()]
    mockLastRunsImpl = () => Promise.reject(new Error('NOT_FOUND'))
    renderPage()
    const dash = await screen.findByTestId('rule-last-run-failed')
    expect(dash.textContent).toBe('—')
    expect(dash.getAttribute('title')).toMatch(/NOT_FOUND/)
    expect(screen.queryByText(/Not in the last/)).toBeNull()
  })

  it('answered and present: relative time plus the status', async () => {
    mockRules = [rule()]
    mockLastRunsImpl = () =>
      Promise.resolve({
        runs: [{ ruleId: 'r1', lastAt: Date.now() - 2 * 3_600_000, status: 'dead', deviceId: 101 }],
        horizonMs: 7 * DAY_MS,
      })
    renderPage()
    await waitFor(() => expect(screen.getByText('2h ago')).toBeTruthy())
    expect(screen.getByTestId('rule-last-run-dot').getAttribute('title')).toBe('dead')
  })
})

describe('the History action', () => {
  beforeEach(resetHarness)

  it('hands the row to the History tab, and renders nothing without a host to hand to', async () => {
    mockRules = [rule()]
    const onOpenHistory = vi.fn()

    const without = renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(screen.queryByLabelText('history of Front door')).toBeNull()
    without.unmount()

    renderPage({ onOpenHistory })
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('history of Front door'))
    expect(onOpenHistory).toHaveBeenCalledTimes(1)
    expect(onOpenHistory.mock.calls[0]![0]).toMatchObject({ id: 'r1' })
  })
})

// ── D690: the rules list ────────────────────────────────────────────

describe('the rules list (D690)', () => {
  beforeEach(resetHarness)

  it('R1: lists the rules by NAME, whatever order the store answered in', async () => {
    mockRules = [
      rule({ id: 'a', name: 'Vialetto', updatedAt: 9 }),
      rule({ id: 'b', name: 'Allarme', updatedAt: 5 }),
      rule({ id: 'c', name: 'Mansarda', updatedAt: 7 }),
    ]
    renderPage()
    await waitFor(() => expect(screen.getByText('Vialetto')).toBeTruthy())
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent)
    expect(names).toEqual(['Allarme', 'Mansarda', 'Vialetto'])
  })

  it('R2: a click on the row opens the rule; a click on a control inside it does not', async () => {
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    // No Edit button any more: the row is the target.
    expect(screen.queryByTitle('Edit')).toBeNull()

    fireEvent.click(screen.getByLabelText('toggle Front door'))
    fireEvent.click(screen.getByLabelText('snooze Front door'))
    fireEvent.click(screen.getByLabelText('delete Front door'))
    // A click on delete opens the shared confirm dialog — never the rule editor.
    const isolationDialog = await screen.findByRole('dialog')
    expect(screen.queryByText('Edit Front door')).toBeNull()
    fireEvent.click(within(isolationDialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mockDelete).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('row')[1]!)
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
  })

  it('R3: a Snooze column with a switch — and an empty cell, no prose, on an alarm rule', async () => {
    mockRules = [
      rule(),
      rule({
        id: 'alarm',
        name: 'Allarme scattato',
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['alarm-triggered'] } },
      }),
    ]
    renderPage()
    await waitFor(() => expect(screen.getByText('Allarme scattato')).toBeTruthy())
    expect(screen.getByRole('columnheader', { name: 'Snooze' })).toBeTruthy()
    expect(screen.getByLabelText('snooze Front door').getAttribute('role')).toBe('switch')
    expect(screen.queryByLabelText('snooze Allarme scattato')).toBeNull()
    expect(screen.queryByText(/Snooze disabled/)).toBeNull()
  })

  it('R3: the switch reads a live window as ON, and turning it off ends that window', async () => {
    mockRules = [rule()]
    mockListSnoozes.mockImplementationOnce(() =>
      Promise.resolve({
        snoozes: [
          {
            id: 'live',
            userId: 'admin',
            scope: 'rule' as const,
            ruleId: 'r1',
            startedAt: 0,
            expiresAt: Date.now() + 600_000,
            global: false,
            summary: true,
          },
        ],
      }),
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByLabelText('snooze Front door').getAttribute('aria-checked')).toBe('true'),
    )
    fireEvent.click(screen.getByLabelText('snooze Front door'))
    await waitFor(() => expect(mockCancelSnooze).toHaveBeenCalledWith({ snoozeId: 'live' }))
  })

  it('R4: delete asks through the shared confirm dialog, not in the row', async () => {
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('delete Front door'))
    // The confirm is the shared centered dialog (`useConfirm`) — the SAME
    // control the device table's delete action uses, not a bespoke popover
    // anchored to the button, and the row itself gains no Confirm / Cancel
    // buttons.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete this rule?')).toBeTruthy()
    expect(within(dialog).getByText(/will permanently delete "Front door"/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Delete this rule?')).toBeNull())
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('a disarmed delete (no confirm click) never calls deleteRule', async () => {
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('delete Front door'))
    await screen.findByRole('dialog')
    // No click on the dialog's Delete button — only opening the confirm must
    // never be enough to delete.
    await waitFor(() => expect(mockDelete).not.toHaveBeenCalled())
  })
})

describe('the Snooze switch — a window opened AFTER the list mounted (review round 2)', () => {
  beforeEach(resetHarness)

  it('turns ON when opened, and OFF again when that window runs out', async () => {
    mockRules = [rule()]
    renderPage()
    const toggle = await screen.findByLabelText('snooze Front door')
    // Let the mount clock fall behind the window's start.
    await new Promise((r) => setTimeout(r, 50))
    mockListSnoozes.mockImplementation(() => {
      const startedAt = Date.now()
      return Promise.resolve({
        snoozes: [
          {
            id: 'late',
            userId: 'admin',
            scope: 'rule' as const,
            ruleId: 'r1',
            startedAt,
            expiresAt: startedAt + 300,
            global: false,
            summary: true,
          },
        ],
      })
    })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(screen.getByLabelText('snooze Front door').getAttribute('aria-checked')).toBe('true'),
    )
    mockListSnoozes.mockImplementation(() => Promise.resolve({ snoozes: [] }))
    await waitFor(
      () =>
        expect(screen.getByLabelText('snooze Front door').getAttribute('aria-checked')).toBe(
          'false',
        ),
      { timeout: 3000 },
    )
  })
})

describe('the rules list — keyboard (D690 review M4)', () => {
  beforeEach(resetHarness)

  it('the rule name is a focusable button that opens the rule', async () => {
    mockRules = [rule()]
    renderPage()
    const name = await screen.findByRole('button', { name: 'Front door' })
    name.focus()
    expect(document.activeElement).toBe(name)
    fireEvent.click(name)
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
  })
})

describe('the Snooze switch — failure and expiry (D690 review M6)', () => {
  beforeEach(resetHarness)

  it('says so IN the row when the snooze could not be opened', async () => {
    mockRules = [rule()]
    mockCreateSnooze.mockImplementationOnce(() => Promise.reject(new Error('hub refused')))
    renderPage()
    fireEvent.click(await screen.findByLabelText('snooze Front door'))
    expect(await screen.findByText('The snooze could not be changed.')).toBeTruthy()
  })

  it('turns itself OFF when the window runs out, without a reload', async () => {
    mockRules = [rule()]
    const window = {
      id: 'short',
      userId: 'admin',
      scope: 'rule' as const,
      ruleId: 'r1',
      startedAt: 0,
      expiresAt: Date.now() + 300,
      global: false,
      summary: true,
    }
    mockListSnoozes.mockImplementation(() => Promise.resolve({ snoozes: [window] }))
    renderPage()
    await waitFor(() =>
      expect(screen.getByLabelText('snooze Front door').getAttribute('aria-checked')).toBe('true'),
    )
    await waitFor(
      () =>
        expect(screen.getByLabelText('snooze Front door').getAttribute('aria-checked')).toBe(
          'false',
        ),
      { timeout: 3000 },
    )
  })
})

// ── Immediate, grouped (D692, T18) ──────────────────────────────────

describe('the "Immediate, grouped" trigger choice', () => {
  beforeEach(resetHarness)

  async function openNewRule(): Promise<void> {
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await openNewEventRuleFromAll()
  }

  function triggerSelect(): HTMLSelectElement {
    const select = screen.getByDisplayValue('Immediate')
    if (!(select instanceof HTMLSelectElement)) throw new Error('trigger is not a <select>')
    return select
  }

  it('shows the seconds input pre-filled with 20, and the hint naming 20 s', async () => {
    await openNewRule()
    expect(screen.queryByTestId('rule-grouping-sec')).toBeNull()
    fireEvent.change(triggerSelect(), { target: { value: 'immediate-grouped' } })
    const input = await screen.findByTestId('rule-grouping-sec')
    expect((input as HTMLInputElement).value).toBe('20')
    expect(screen.getByText(/waits up to 20 s for subjects to be recognised/)).toBeTruthy()
    expect(
      screen.getByText(/At least 5 s: subjects arriving together share one message/),
    ).toBeTruthy()
  })

  it('creates the rule with delivery immediate and groupingSec, edited seconds included', async () => {
    await openNewRule()
    fireEvent.change(triggerSelect(), { target: { value: 'immediate-grouped' } })
    fireEvent.change(await screen.findByTestId('rule-grouping-sec'), { target: { value: '30' } })
    fireEvent.change(screen.getByPlaceholderText(/Front door package/i), {
      target: { value: 'Grouped rule' },
    })
    fireEvent.click(screen.getByText('Alerts'))
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1))
    const arg = mockCreate.mock.calls[0]![0] as { rule: NcRule }
    expect(arg.rule.delivery).toBe('immediate')
    expect(arg.rule.groupingSec).toBe(30)
  })

  it('shows the reason after Create when the seconds leave 5..60', async () => {
    await openNewRule()
    fireEvent.change(triggerSelect(), { target: { value: 'immediate-grouped' } })
    fireEvent.change(await screen.findByTestId('rule-grouping-sec'), { target: { value: '3' } })
    expect(screen.queryByTestId('rule-form-problems')).toBeNull()
    fireEvent.click(screen.getByText('Create rule'))
    await waitFor(() => expect(screen.getByText(/between 5 and 60/)).toBeTruthy())
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('the wait-for-recognition switch is gone', async () => {
    mockRules = [rule({ delivery: 'immediate', conditions: { identities: [] } })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
    await screen.findByLabelText('allow global snooze')
    expect(screen.queryByLabelText('wait for recognition')).toBeNull()
  })

  it('an identity-scoped plain Immediate rule says it fires only on a known name', async () => {
    mockRules = [rule({ delivery: 'immediate', conditions: { identities: [] } })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
    expect(screen.getByText(/Fires only if the name is already known/)).toBeTruthy()
  })

  it('a plain Immediate rule with no name scope shows no recognition hint', async () => {
    mockRules = [rule({ delivery: 'immediate', conditions: { classes: ['person'] } })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
    expect(screen.queryByText(/Fires only if the name is already known/)).toBeNull()
  })

  it('an identity-scoped grouped rule says an unrecognised subject is not notified', async () => {
    mockRules = [rule({ delivery: 'immediate', groupingSec: 25, conditions: { identities: [] } })]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    openRuleRow('Front door')
    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
    expect((screen.getByTestId('rule-grouping-sec') as HTMLInputElement).value).toBe('25')
    expect(screen.getByText(/not recognised within 25 s is not notified/)).toBeTruthy()
    expect(screen.queryByText(/Fires only if the name is already known/)).toBeNull()
  })

  it('lists a grouped rule as "Immediate, grouped · 20 s"', async () => {
    mockRules = [rule({ delivery: 'immediate', groupingSec: 20 })]
    renderPage()
    await waitFor(() => expect(screen.getByText('Immediate, grouped · 20 s')).toBeTruthy())
  })

  it('switching a grouped rule to plain Immediate saves with groupingSec in clear', async () => {
    mockRules = [rule({ delivery: 'immediate', groupingSec: 20 })]
    const arg = await saveEditedRule(async () => {
      fireEvent.change(screen.getByDisplayValue('Immediate, grouped'), {
        target: { value: 'immediate' },
      })
    })
    expect(arg.clear).toContain('groupingSec')
    expect('groupingSec' in arg.patch).toBe(false)
  })
})

// ── The unified table: every kind of rule in ONE list ───────────────

const SUMMARY_ROW = {
  id: 'sum_1',
  name: 'Overnight sweep',
  enabled: true,
  deviceIds: [101],
  window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 3600 },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: [{ targetId: 't1' }],
  deliverEmpty: false,
  priority: 3,
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 2,
  readOnly: false,
}

const CALENDAR_ROW = {
  id: 'cal_1',
  name: 'Week ahead',
  enabled: true,
  schedule: {
    timezone: 'Europe/Rome',
    windows: [{ days: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 421 }],
  },
  horizonDays: 7,
  deliverEmpty: false,
  targets: [{ targetId: 't1' }],
  priority: 3,
}

function answerProducers(): void {
  mockBridgeAnswers = {
    'nc.listSummaryRules': { rules: [SUMMARY_ROW] },
    'nc.listTimelapseRules': { rules: [] },
    'nc.listCalendarEventsRules': { rules: [CALENDAR_ROW] },
  }
}

describe('the unified Rules table', () => {
  beforeEach(resetHarness)

  it('All lists event rules and producer rows together, each with its Type', async () => {
    answerProducers()
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()

    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Overnight sweep')).toBeTruthy())
    expect(screen.getByText('Week ahead')).toBeTruthy()

    expect(screen.getByTestId('rule-type-r1').textContent).toBe('Detection')
    expect(screen.getByTestId('rule-type-sum_1').textContent).toBe('Summary')
    expect(screen.getByTestId('rule-type-cal_1').textContent).toBe('Calendar events')
    // Name · Type · When — one header row for every family.
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'When' })).toBeTruthy()
  })

  it('counts every strip tab from the same rows the table shows', async () => {
    answerProducers()
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Overnight sweep')).toBeTruthy())

    // 1 event + 1 summary + 1 calendar-events rule.
    expect(screen.getByRole('tab', { name: /All rules/ }).textContent).toContain('3')
    expect(screen.getByRole('tab', { name: /Summaries/ }).textContent).toContain('1')
    expect(screen.getByRole('tab', { name: /Timelapses/ }).textContent).toContain('0')
    expect(screen.getByRole('tab', { name: /Calendar events/ }).textContent).toContain('1')
  })

  it('a producer tab keeps only its own rows, under its own columns', async () => {
    answerProducers()
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Overnight sweep')).toBeTruthy())

    await openSection(/Summaries/)
    expect(screen.getByText('Overnight sweep')).toBeTruthy()
    expect(screen.queryByText('Front door')).toBeNull()
    expect(screen.queryByText('Week ahead')).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Keeps' })).toBeTruthy()
  })

  it('New rule → Calendar events opens its editor in place, staying on All', async () => {
    answerProducers()
    renderPage()
    await openNewRuleTypeFromAll('calendar-events')

    await waitFor(() => expect(screen.getByTestId('calendar-events-name')).toBeTruthy())
    expect(screen.getByRole('tab', { name: /All rules/ }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('New rule → Summary opens the summary editor in place, staying on All', async () => {
    renderPage()
    await openNewRuleTypeFromAll('summary')

    await waitFor(() => expect(screen.getByText('What it is')).toBeTruthy())
    expect(screen.getByRole('tab', { name: /All rules/ }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('a producer row opens ITS editor — not the event-rule dialog', async () => {
    answerProducers()
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Week ahead')).toBeTruthy())

    // A cell that is NOT the name button: the click must reach the ROW handler,
    // which routes by family (the name button opens through its own handler).
    fireEvent.click(screen.getByTestId('rule-type-cal_1'))

    await waitFor(() => expect(screen.getByTestId('calendar-events-name')).toBeTruthy())
    expect(screen.queryByText('Edit Front door')).toBeNull()
  })

  it('an event row still opens the event-rule dialog from All', async () => {
    answerProducers()
    mockRules = [rule()]
    mockTargets = [target('t1', 'Alerts')]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())

    fireEvent.click(screen.getByTestId('rule-type-r1'))

    await waitFor(() => expect(screen.getByText('Edit Front door')).toBeTruthy())
    expect(screen.queryByTestId('calendar-events-name')).toBeNull()
  })

  it('a hub without the producer actions leaves the event rules on All untouched', async () => {
    // Default bridge answer is `{kind:'none'}` — not a rule list the build can narrow.
    mockRules = [rule()]
    renderPage()
    await waitFor(() => expect(screen.getByText('Front door')).toBeTruthy())
    expect(screen.getByRole('tab', { name: /All rules/ }).textContent).toContain('1')
    await openSection(/Summaries/)
    await waitFor(() =>
      expect(screen.getByText('Summary rules are not available on this hub')).toBeTruthy(),
    )
  })
})
