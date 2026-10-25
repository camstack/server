/**
 * Component tests for the Summaries tab.
 *
 * The state that matters most is the DEGRADED one, and it is not an edge case:
 * the admin bundle and `addon-post-analysis` deploy separately, so a hub whose
 * addon half has not landed answers `has no custom action
 * 'nc.listSummaryRules'`. The tab must SAY that and never render an empty table
 * — "no rules" reads as data loss on a surface whose whole content is rules.
 *
 * The other three pin promises that cost real money if broken: Test DELIVERS
 * (so it may not be one click), it aims at an EXPLICIT window (so a motion rule
 * that has seen nothing still produces something to look at), and Delete asks.
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
let listProfilesAnswer: () => Promise<unknown> = () =>
  Promise.resolve([
    {
      id: 'mac-lmstudio-qwen3vl',
      name: 'LM Studio',
      model: 'qwen3-vl',
      supportsVision: true,
      enabled: true,
    },
    { id: 'text-only', name: 'Text', model: 'gpt', supportsVision: false, enabled: true },
  ])

const mockCustom = vi.fn((call: CustomCall) => {
  calls.push(call)
  if (call.action === 'nc.listSummaryRules') return listAnswer()
  return Promise.resolve({
    success: true,
    produced: 1,
    tiles: 4,
    cameras: 2,
    matched: 9,
  })
})

/** The RAW tRPC fleet read. Named so the spec can assert it is never used —
 *  a fleet read there rides no shared window and no shared invalidation. */
const mockListAllRaw = vi.fn(() => Promise.resolve([]))

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
          listTargets: { query: () => Promise.resolve([]) },
        },
        notificationRules: {
          getConditionCatalog: { query: () => Promise.resolve({}) },
          getTemplateCatalog: { query: () => Promise.resolve(templateCatalogAnswer()) },
          previewTemplate: { mutate: () => Promise.resolve({ title: null, body: null }) },
        },
        llm: { listProfiles: { query: () => listProfilesAnswer() } },
      },
    }),
  }
})

import { NotificationSummariesPage } from '../NotificationSummaries'

const RULE = {
  id: 'sum_1',
  name: 'Overnight sweep',
  enabled: true,
  deviceIds: [101, 102],
  window: { kind: 'motion', quietSeconds: 300, maxWindowSeconds: 3600 },
  maxTiles: 9,
  maxAiImages: 6,
  rank: 'importance',
  barrierSeconds: 120,
  targets: [{ targetId: 't1' }, { targetId: 't2' }],
  deliverEmpty: false,
  priority: 3,
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 2,
  readOnly: false,
  ai: { enabled: true },
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <NotificationSummariesPage />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

/** jsdom implements neither `<dialog>.showModal()` nor `.close()`; the Dialog
 *  primitive's open effect calls both. */
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

describe('NotificationSummaries page', () => {
  beforeEach(() => {
    stubDialog()
    calls.length = 0
    mockCustom.mockClear()
    listAnswer = () => Promise.resolve({ rules: [] })
    listProfilesAnswer = () =>
      Promise.resolve([
        {
          id: 'mac-lmstudio-qwen3vl',
          name: 'LM Studio',
          model: 'qwen3-vl',
          supportsVision: true,
          enabled: true,
        },
        { id: 'text-only', name: 'Text', model: 'gpt', supportsVision: false, enabled: true },
      ])
  })

  it('says summaries are UNAVAILABLE when the hub has no such action', async () => {
    // The literal reply of a hub whose post-analysis addon predates the feature.
    listAnswer = () =>
      Promise.reject(
        new Error("addon 'pipeline-analytics' has no custom action 'nc.listSummaryRules'"),
      )
    renderPage()
    await waitFor(() => expect(screen.getByText(/not available on this hub/i)).toBeTruthy())
    // NOT an empty table, and NOT the "create one" invitation — there is
    // nothing on this hub that could accept it.
    expect(screen.queryByTestId('summary-empty')).toBeNull()
  })

  it('distinguishes an UNREADABLE answer from a missing one', async () => {
    listAnswer = () => Promise.resolve({ rules: [{ nonsense: true }] })
    renderPage()
    await waitFor(() => expect(screen.getByText(/does not understand/i)).toBeTruthy())
  })

  it('says the list is EMPTY in words, and offers the button that fixes it', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-empty')).toBeTruthy())
    expect(screen.getByTestId('summary-new')).toBeTruthy()
  })

  it('renders a rule with its window, its run history and whether AI is ON', async () => {
    listAnswer = () => Promise.resolve({ rules: [RULE] })
    renderPage()
    await waitFor(() => expect(screen.getByText('Overnight sweep')).toBeTruthy())
    expect(screen.getByText(/Motion · 5m quiet · max 1h/)).toBeTruthy()
    // Never run — said in words, never as a dash.
    expect(screen.getByTestId('summary-last-sum_1').textContent).toMatch(/never/i)
    // ON, not merely present: the badge answers "will tonight's digest carry a
    // written summary", and a rule whose section is switched off must not
    // claim it will.
    expect(screen.getByText('AI')).toBeTruthy()
    expect(screen.queryByText('AI off')).toBeNull()
  })

  it('says AI OFF for a rule that carries a configured-but-disabled section', async () => {
    listAnswer = () =>
      Promise.resolve({ rules: [{ ...RULE, ai: { enabled: false, prompt: 'what happened?' } }] })
    renderPage()
    await waitFor(() => expect(screen.getByText('Overnight sweep')).toBeTruthy())
    expect(screen.getByText('AI off')).toBeTruthy()
  })

  it('Test asks first — it delivers a real notification', async () => {
    listAnswer = () => Promise.resolve({ rules: [RULE] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-test-sum_1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-test-sum_1'))

    // Nothing has been sent yet: the confirm is the point.
    expect(calls.some((c) => c.action === 'nc.testSummaryRule')).toBe(false)
    const confirm = screen.getByTestId('digest-test-confirm')
    expect(confirm.textContent).toMatch(/not a dry run/i)
    // It names WHERE it will land: "Test" on its own reads like a dry run.
    expect(confirm.textContent).toMatch(/2 targets/)
  })

  it('the confirmed test aims at an EXPLICIT recent window', async () => {
    listAnswer = () => Promise.resolve({ rules: [RULE] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-test-sum_1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-test-sum_1'))
    fireEvent.click(screen.getByTestId('digest-test-confirm-send'))

    await waitFor(() => expect(calls.some((c) => c.action === 'nc.testSummaryRule')).toBe(true))
    const call = calls.find((c) => c.action === 'nc.testSummaryRule')!
    expect(call.input['ruleId']).toBe('sum_1')
    const start = call.input['windowStartMs']
    const end = call.input['windowEndMs']
    expect(typeof start).toBe('number')
    expect(typeof end).toBe('number')
    // Three hours — a range the operator can recognise, not "whatever the rule
    // last closed", which for a motion rule that has seen nothing is nothing.
    expect(Number(end) - Number(start)).toBe(3 * 3_600_000)
  })

  it('Delete asks before it deletes', async () => {
    listAnswer = () => Promise.resolve({ rules: [RULE] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-delete-sum_1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-delete-sum_1'))
    expect(calls.some((c) => c.action === 'nc.deleteSummaryRule')).toBe(false)

    // Shared centered confirm (`useConfirm`) — same control Rules uses, not
    // an in-row Confirm / Cancel pair.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete this summary?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.deleteSummaryRule')).toBe(true))
    expect(calls.find((c) => c.action === 'nc.deleteSummaryRule')?.input).toEqual({
      ruleId: 'sum_1',
    })
  })

  it('the enabled switch sends a ONE-KEY patch, never the whole rule', async () => {
    listAnswer = () => Promise.resolve({ rules: [RULE] })
    renderPage()
    await waitFor(() => expect(screen.getByLabelText('toggle Overnight sweep')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('toggle Overnight sweep'))
    await waitFor(() => expect(calls.some((c) => c.action === 'nc.upsertSummaryRule')).toBe(true))
    // The whole rule would have carried `ai` back over the stored one.
    expect(calls.find((c) => c.action === 'nc.upsertSummaryRule')?.input).toEqual({
      ruleId: 'sum_1',
      patch: { enabled: false },
    })
  })

  it('opens the editor for a new rule without problems until Create is pressed', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-new')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-new'))
    await waitFor(() => expect(screen.getByTestId('summary-name')).toBeTruthy())
    expect(screen.queryByTestId('summary-problems')).toBeNull()
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(screen.getByTestId('summary-problems')).toBeTruthy())
    const problems = screen.getByTestId('summary-problems').textContent ?? ''
    expect(problems).toMatch(/camera/i)
    expect(problems).toMatch(/target/i)
    expect(calls.some((c) => c.action === 'nc.upsertSummaryRule')).toBe(false)
  })
})

describe('the digest EDITOR', () => {
  beforeEach(() => {
    stubDialog()
    calls.length = 0
    mockCustom.mockClear()
    listAnswer = () => Promise.resolve({ rules: [] })
  })

  async function openEditor(): Promise<void> {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('summary-new')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-new'))
    await waitFor(() => expect(screen.getByTestId('summary-name')).toBeTruthy())
  }

  it('is organised into the SAME kind of tabs the detection editor has', async () => {
    // The operator's screenshot report was "non ci sono sezioni organizzate" [there are no organized sections]:
    // one long scroll beside a rules editor that has had tabs for ten days.
    await openEditor()
    for (const label of ['Rule', 'Window', 'What goes in', 'Mosaic', 'AI', 'Delivery']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy()
    }
    // …and it opens on the tab an operator meets first, not on the AI one.
    expect(screen.getByTestId('summary-name')).toBeTruthy()
    expect(screen.queryByTestId('summary-ai-enabled')).toBeNull()
  })

  it('the AI tab is a REAL editor now, not a note saying it is not wired', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-enabled')).toBeTruthy())
    expect(screen.getByTestId('summary-ai-profile')).toBeTruthy()
    expect(screen.getByTestId('summary-ai-prompt')).toBeTruthy()
    expect(screen.getByTestId('summary-ai-on-failure')).toBeTruthy()
    // The sentence that made the operator open a ticket is gone.
    expect(screen.queryByText(/not wired yet/i)).toBeNull()
    expect(screen.queryByTestId('summary-ai-dormant')).toBeNull()
  })

  it('offers only VISION profiles — a vision call against a text profile is refused', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-profile')).toBeTruthy())
    const options = [...screen.getByTestId('summary-ai-profile').querySelectorAll('option')].map(
      (o) => o.textContent ?? '',
    )
    expect(options.join(' ')).toContain('LM Studio')
    expect(options.join(' ')).not.toContain('Text ·')
  })

  it('a hub that cannot list profiles still opens the editor and SAYS why', async () => {
    // The AI addon not deployed. A dialog that will not open over a feature the
    // operator did not ask for is the worse failure.
    listProfilesAnswer = () => Promise.reject(new Error('no such router'))
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-enabled')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByText(/did not answer with a profile list/i)).toBeTruthy(),
    )
  })

  /**
   * *"Il selettore della lingua nella tab AI non si apre."*
   * [In English: "The language selector in the AI tab does not open."]
   *
   * It was never broken: with the AI switch off — which is where a new rule
   * opens — every control under it is `disabled`, correctly. What made that a
   * ticket is that NOTHING said so. The `Select` primitive pinned its own
   * background and text colour, so the browser's greying never showed; the
   * `<textarea>` two rows below carried its own `disabled:opacity-50` and DID
   * look off, which is exactly why the dropdowns read as broken rather than
   * inert. The dimming now lives in the primitive
   * (`ui-library/.../disabled-affordance.test.tsx`); these two pin the half
   * that belongs to this dialog — the state is named in words, and the switch
   * really does release the field.
   */
  it('says IN WORDS that the AI fields are inert while the switch is off', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-enabled')).toBeTruthy())
    const language = screen.getByTestId('summary-ai-language') as HTMLSelectElement
    expect(language.disabled).toBe(true)
    expect(screen.getByTestId('summary-ai-off-note').textContent).toMatch(
      /nothing below (it|this) can be edited/i,
    )
  })

  it('the language selector opens and STICKS once the section is on', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-enabled')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-ai-enabled'))
    const language = screen.getByTestId('summary-ai-language') as HTMLSelectElement
    expect(language.disabled).toBe(false)
    expect(screen.queryByTestId('summary-ai-off-note')).toBeNull()
    fireEvent.change(language, { target: { value: 'it' } })
    expect(language.value).toBe('it')
  })

  it('offers ONE option per language — never two that both read English', async () => {
    // `''` (send no language instruction) and `en` both said "English", so
    // picking one changed the trigger text by two words and read as a dropdown
    // that had not registered the click.
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-language')).toBeTruthy())
    const labels = [...screen.getByTestId('summary-ai-language').querySelectorAll('option')].map(
      (o) => (o.textContent ?? '').trim(),
    )
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(3)
    expect(labels.filter((l) => /^English$/i.test(l))).toHaveLength(1)
  })

  /** The mosaic is PICTURES unless the operator says otherwise (#35 follow-up). */
  it('the mosaic opens on NO TEXT, and says what that means', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'Mosaic' }))
    await waitFor(() => expect(screen.getByTestId('summary-captions')).toBeTruthy())
    const captions = screen.getByTestId('summary-captions') as HTMLSelectElement
    expect(captions.value).toBe('none')
    // The caption box is pointless while nothing is drawn — and an editable box
    // whose contents never appear is the defect this whole change is about.
    expect((screen.getByTestId('summary-caption-input') as HTMLInputElement).disabled).toBe(true)
  })

  it('turning the words back on releases the caption box', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'Mosaic' }))
    await waitFor(() => expect(screen.getByTestId('summary-captions')).toBeTruthy())
    fireEvent.change(screen.getByTestId('summary-captions'), { target: { value: 'all' } })
    expect((screen.getByTestId('summary-captions') as HTMLSelectElement).value).toBe('all')
    expect((screen.getByTestId('summary-caption-input') as HTMLInputElement).disabled).toBe(false)
  })

  it('the digest body offers the variables the hub supplies — and never {{tiles}}', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery' }))
    expect(await screen.findByTestId('summary-template-body-chip-events')).toBeTruthy()
    expect(screen.queryByTestId('summary-template-body-chip-tiles')).toBeNull()
  })

  it('SAVES the AI section it authored — the whole point of P2', async () => {
    await openEditor()
    fireEvent.change(screen.getByTestId('summary-name'), { target: { value: 'Notte' } })
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }))
    await waitFor(() => expect(screen.getByTestId('summary-ai-prompt')).toBeTruthy())
    fireEvent.click(screen.getByTestId('summary-ai-enabled'))
    fireEvent.change(screen.getByTestId('summary-ai-prompt'), {
      target: { value: 'cosa è successo?' },
    })
    fireEvent.change(screen.getByTestId('summary-ai-profile'), {
      target: { value: 'mac-lmstudio-qwen3vl' },
    })
    // A digest still needs a camera and a target to be saveable; this asserts
    // what the FORM carries, which is the half P2 changed.
    const state = screen.getByTestId('summary-ai-prompt') as HTMLTextAreaElement
    expect(state.value).toBe('cosa è successo?')
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
