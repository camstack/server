/**
 * Component tests for the Timelapses tab.
 *
 * The fixtures are the two rules RUNNING ON THE HUB, fetched verbatim from
 * `nc.listTimelapseRules` on 2026-08-13. The tab's first real use is opening
 * one of them, so the test that matters most is the boring one: open `Timelapse
 * front door`, press Save, and assert the hub is told NOTHING changed. Anything
 * else would retune a producer that runs unattended at 07:00 — and the field it
 * would most likely retune is `denseCadenceSec`, which is ABSENT on both live
 * rules and means "derive it".
 */
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'
import { templateCatalogAnswer } from './template-catalog.fixture'

interface CustomCall {
  readonly addonId: string
  readonly action: string
  readonly input: Record<string, unknown>
}

const calls: CustomCall[] = []
let listAnswer: () => Promise<unknown> = () => Promise.resolve({ rules: [] })

const mockCustom = vi.fn((call: CustomCall) => {
  calls.push(call)
  if (call.action === 'nc.listTimelapseRules') return listAnswer()
  return Promise.resolve({ produced: 1, enqueued: 1, coveragePercent: 91 })
})

const CAMERAS = [
  { id: 101, name: 'Camera front door', type: 'camera' },
  { id: 1441, name: 'Camera retro', type: 'camera' },
]

/** The RAW tRPC fleet read. Named so the spec can assert it is never used —
 *  a fleet read there rides no shared window and no shared invalidation. */
const mockListAllRaw = vi.fn(() => Promise.resolve([]))

/** What the shared fleet query answers in these tests. */
const FLEET_ROWS: readonly FleetRow[] = [
  ...CAMERAS,
  { id: 42, name: 'Serratura front door', type: 'lock' },
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
    // The real field reads the target-kind catalogue through a tRPC React
    // provider these specs never mount; they assert the digest's own fields.
    NotificationTargetsField: () => null,
    useDeviceManagerListAll: (input?: FleetListInput, options?: FleetListOptions) =>
      listAllHook(input, options),
    useSystem: () => ({
      trpcClient: {
        addons: { custom: { mutate: mockCustom } },
        deviceManager: { listAll: { query: mockListAllRaw } },
        notificationOutput: {
          listTargets: {
            query: () =>
              Promise.resolve([
                {
                  id: 'zentik-1784924941052',
                  name: 'Zentik',
                  enabled: true,
                  addonId: 'x',
                },
              ]),
          },
        },
        notificationRules: {
          getConditionCatalog: { query: () => Promise.resolve({}) },
          getTemplateCatalog: { query: () => Promise.resolve(templateCatalogAnswer()) },
          previewTemplate: { mutate: () => Promise.resolve({ title: null, body: null }) },
        },
      },
    }),
  }
})

import { NotificationTimelapsesPage } from '../NotificationTimelapses'

/** `Timelapse front door`, exactly as the hub answers it. */
const LIVE_FRONT_DOOR = {
  name: 'Timelapse front door',
  enabled: true,
  deviceIds: [101],
  schedule: {
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1260, endMinute: 420 }],
    timezone: 'Europe/Rome',
  },
  cadenceSec: 30,
  framerate: 12,
  targets: [{ targetId: 'zentik-1784924941052' }],
  previewMode: 'image',
  priority: 2,
  id: '80b14eac-be1b-4a8f-bccb-1aa04acc4c14',
  lastGeneratedAt: 1786598346092,
  generatedByDevice: { '101': 1786598346092 },
  createdBy: '1476a68a-9864-4aa7-bfb5-a779f9d24ff3',
  createdAt: 1786530558379,
  updatedAt: 1786530558379,
  readOnly: false,
}

const LIVE_RETRO = {
  ...LIVE_FRONT_DOOR,
  name: 'Timelapse retro',
  deviceIds: [1441],
  id: '16fa78ac-9601-4af4-92dd-6ce9783863b3',
  lastGeneratedAt: 1786599255014,
  generatedByDevice: { '1441': 1786599255014 },
}

function stubDialog(): void {
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
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <NotificationTimelapsesPage />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('NotificationTimelapses page', () => {
  beforeEach(() => {
    stubDialog()
    calls.length = 0
    mockCustom.mockClear()
    listAnswer = () => Promise.resolve({ rules: [LIVE_FRONT_DOOR, LIVE_RETRO] })
  })

  it('says timelapses are UNAVAILABLE when the hub has no such action', async () => {
    listAnswer = () =>
      Promise.reject(
        new Error("addon 'pipeline-analytics' has no custom action 'nc.listTimelapseRules'"),
      )
    renderPage()
    await waitFor(() => expect(screen.getByText(/not available on this hub/i)).toBeTruthy())
    expect(screen.queryByTestId('timelapse-empty')).toBeNull()
  })

  it('shows both live rules with the numbers the operator tuned', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Timelapse front door')).toBeTruthy())
    expect(screen.getByText('Timelapse retro')).toBeTruthy()
    // The camera by NAME, not by id.
    expect(screen.getByText('Camera front door')).toBeTruthy()
    // The overnight window read as overnight.
    expect(screen.getAllByText(/21:00–07:00.*overnight/i).length).toBe(2)
    // And the DERIVED dense cadence, marked as derived — it is the knob being
    // tuned and it is absent from the stored rule.
    expect(screen.getAllByText(/dense 1s \(auto\)/).length).toBe(2)
  })

  it('opening a live rule and saving it unchanged tells the hub NOTHING changed', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    await waitFor(() => expect(screen.getByTestId('timelapse-name')).toBeTruthy())

    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.upsertTimelapseRule')).toBe(true))
    const call = calls.find((c) => c.action === 'nc.upsertTimelapseRule')!
    expect(call.input).toEqual({
      ruleId: '80b14eac-be1b-4a8f-bccb-1aa04acc4c14',
      patch: {},
    })
  })

  it('a rename sends the name ALONE — never the derived dense cadence', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    await waitFor(() => expect(screen.getByTestId('timelapse-name')).toBeTruthy())
    fireEvent.change(screen.getByTestId('timelapse-name'), {
      target: { value: 'Timelapse front door (notte)' },
    })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(calls.some((c) => c.action === 'nc.upsertTimelapseRule')).toBe(true))
    expect(calls.find((c) => c.action === 'nc.upsertTimelapseRule')?.input).toEqual({
      ruleId: '80b14eac-be1b-4a8f-bccb-1aa04acc4c14',
      patch: { name: 'Timelapse front door (notte)' },
    })
  })

  it('explains the dense knob with its own arithmetic', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Sampling' })).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Sampling' }))
    await waitFor(() => expect(screen.getByTestId('timelapse-dense-hint')).toBeTruthy())
    const hint = screen.getByTestId('timelapse-dense-hint').textContent ?? ''
    // 7 s at 1 s and 12 fps = 0.58 s on screen — the number nobody can predict.
    expect(hint).toMatch(/0\.58/)
    expect(hint).toMatch(/lower = slower near the detections/i)
  })

  it('the digest body offers the variables the hub supplies — and never {{tiles}}', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-edit-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    await waitFor(() => expect(screen.getByTestId('timelapse-name')).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery' }))
    expect(await screen.findByTestId('timelapse-template-body-chip-events')).toBeTruthy()
    expect(screen.queryByTestId('timelapse-template-body-chip-tiles')).toBeNull()
  })

  it('Test asks first, and asks WHICH camera — one rule is several videos', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-test-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-test-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    expect(calls.some((c) => c.action === 'nc.testTimelapseRule')).toBe(false)
    expect(screen.getByTestId('timelapse-test-camera')).toBeTruthy()

    fireEvent.click(screen.getByTestId('digest-test-confirm-send'))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.testTimelapseRule')).toBe(true))
    expect(calls.find((c) => c.action === 'nc.testTimelapseRule')?.input).toEqual({
      ruleId: '80b14eac-be1b-4a8f-bccb-1aa04acc4c14',
      deviceId: 101,
    })
  })

  it('a new rule cannot be saved until it has a window, a camera and a target', async () => {
    listAnswer = () => Promise.resolve({ rules: [] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('timelapse-new')).toBeTruthy())
    fireEvent.click(screen.getByTestId('timelapse-new'))
    await waitFor(() => expect(screen.getByText('Create')).toBeTruthy())
    expect(screen.queryByTestId('timelapse-problems')).toBeNull()
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(screen.getByTestId('timelapse-problems')).toBeTruthy())
    const problems = screen.getByTestId('timelapse-problems').textContent ?? ''
    expect(problems).toMatch(/camera/i)
    expect(problems).toMatch(/window/i)
    expect(problems).toMatch(/target/i)
    expect(calls.some((c) => c.action === 'nc.upsertTimelapseRule')).toBe(false)
  })

  it('Delete asks before it deletes', async () => {
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByTestId('timelapse-delete-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'),
      ).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('timelapse-delete-80b14eac-be1b-4a8f-bccb-1aa04acc4c14'))
    expect(calls.some((c) => c.action === 'nc.deleteTimelapseRule')).toBe(false)
    // Shared centered confirm (`useConfirm`) — same control Rules uses, not
    // an in-row Confirm / Cancel pair.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete this timelapse?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.deleteTimelapseRule')).toBe(true))
  })
})

describe('the fleet read', () => {
  it('goes through the shared client, slim, and never through the raw tRPC client', () => {
    listAllHook.mockClear()
    mockListAllRaw.mockClear()
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
    expect(mockListAllRaw).not.toHaveBeenCalled()
  })
})
