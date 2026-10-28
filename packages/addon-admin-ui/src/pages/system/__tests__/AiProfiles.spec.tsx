/**
 * Component tests for the AI page.
 *
 * Two things are pinned here.
 *
 * **The DEFAULT-PROFILE surface.** `llm.getDefaults` / `llm.setDefault` shipped
 * with the cap and had no UI at all: the resolution chain that every consumer
 * (`notifier-rules`, scene monitors, ai-summary) falls back to was unreachable
 * from the admin, and the only way to name a default was a hand-written tRPC
 * call.
 *
 * **The uniformity fixes.** The page's tabs are URL state and its editor is a
 * modal. Both were rewrites of surfaces that had shipped and looked fine to
 * whoever wrote them — a tab strip whose selection a refresh discarded, and an
 * "Add profile" button whose form appeared below the fold. Neither is
 * observable from a screenshot, so they are asserted.
 */

import type {
  LlmDefault,
  LlmListModelsInput,
  LlmListModelsResult,
  LlmProfile,
  LlmProfileKindDescriptor,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockProfiles: LlmProfile[] = []
let mockDefaults: LlmDefault[] = []
let mockKinds: LlmProfileKindDescriptor[] = []

const mockListProfiles = vi.fn((): Promise<readonly LlmProfile[]> => Promise.resolve(mockProfiles))
const mockListKinds = vi.fn(
  (): Promise<readonly LlmProfileKindDescriptor[]> => Promise.resolve(mockKinds),
)
const mockGetDefaults = vi.fn((): Promise<readonly LlmDefault[]> => Promise.resolve(mockDefaults))
const mockSetDefault = vi.fn(
  (_i: { selector: unknown; profileId: string | null }): Promise<void> => Promise.resolve(),
)
let mockPresence: 'pending' | 'present' | 'absent' | 'unknown' = 'present'
const mockConfirm = vi.fn((_o: unknown): Promise<boolean> => Promise.resolve(false))
const mockDelete = vi.fn((_i: unknown): Promise<void> => Promise.resolve())
const mockUpsert = vi.fn(
  (i: { profile: LlmProfile }): Promise<LlmProfile> => Promise.resolve(i.profile),
)
let mockListResult: LlmListModelsResult = { ok: true, models: [] }
const mockListModels = vi.fn(
  (_i: LlmListModelsInput): Promise<LlmListModelsResult> => Promise.resolve(mockListResult),
)

interface ErrorBoxProps {
  readonly title?: string
  readonly message: ReactNode
}

/**
 * `t(key, fallback, vars)` — the fallback is what the page renders whenever the
 * catalog has no entry, so honouring it keeps the assertions about the page's
 * own words rather than about i18n key names. `{{var}}` is interpolated for the
 * same reason: a mock that skipped it would let a broken interpolation ship.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, vars?: Record<string, unknown>) => {
      const template = typeof fallback === 'string' ? fallback : key
      if (vars === undefined) return template
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        name in vars ? String(vars[name]) : whole,
      )
    },
    i18n: { language: 'en' },
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        llm: {
          listProfiles: { query: mockListProfiles },
          listProfileKinds: { query: mockListKinds },
          getDefaults: { query: mockGetDefaults },
          setDefault: { mutate: mockSetDefault },
          upsertProfile: { mutate: mockUpsert },
          listModels: { mutate: mockListModels },
          deleteProfile: { mutate: mockDelete },
          testProfile: { mutate: vi.fn() },
          getUsage: { query: vi.fn(() => Promise.resolve([])) },
          listRuntimeNodes: { query: vi.fn(() => Promise.resolve([])) },
          listModelCatalog: { query: vi.fn(() => Promise.resolve([])) },
        },
        deviceManager: { listAll: { query: vi.fn(() => Promise.resolve([])) } },
        pipelineAnalytics: {
          listRecentTracks: {
            query: vi.fn(() => Promise.resolve({ tracks: [], nextCursor: null })),
          },
        },
        addons: { custom: { mutate: vi.fn() } },
      },
    }),
    ErrorBox: ({ message }: ErrorBoxProps) => <div>{message}</div>,
    useCapabilityPresence: () => mockPresence,
    useConfirm: () => mockConfirm,
  }
})

const { AiProfilesPage } = await import('../AiProfiles')

function profile(over: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: 'p-vision',
    name: 'Mac LM-Studio Qwen3-VL 8B',
    kind: 'openai-compatible',
    addonId: 'ai',
    enabled: true,
    model: 'qwen/qwen3-vl-8b',
    supportsVision: true,
    timeoutMs: 60_000,
    connectTimeoutMs: 10_000,
    firstTokenTimeoutMs: 120_000,
    idleTimeoutMs: 60_000,
    retry: { enabled: false, maxAttempts: 1 },
    toolsEnabled: false,
    providerConfig: {},
    ...over,
  }
}

function kind(over: Partial<LlmProfileKindDescriptor> = {}): LlmProfileKindDescriptor {
  return {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    icon: 'plug',
    addonId: 'ai',
    connectionSchema: { sections: [] },
    features: { vision: false, tools: false, streaming: true },
    visionEditable: true,
    modelCatalog: 'fetch',
    profileFields: ['temperature', 'maxTokens', 'systemPrompt', 'timeoutMs'],
    ...over,
  }
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

function renderPage(initialUrl = '/system/ai'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <AiProfilesPage />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('AiProfilesPage — default profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProfiles = [
      profile(),
      profile({ id: 'p-text', name: 'Local Qwen 1.5B', supportsVision: false }),
    ]
    mockDefaults = []
    mockKinds = [kind()]
  })

  it('offers a vision default picker listing only vision-capable profiles', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Default vision profile')
    await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(2))
    const options = [...picker.querySelectorAll('option')].map((o) => o.getAttribute('value'))
    expect(options).toContain('p-vision')
    expect(options).not.toContain('p-text')
  })

  it('sets the vision default through llm.setDefault', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Default vision profile')
    // The profile list arrives AFTER the select exists; choosing an option
    // that is not mounted yet silently keeps the current value.
    await waitFor(() => expect(picker.querySelector('option[value="p-vision"]')).not.toBeNull())
    fireEvent.change(picker, { target: { value: 'p-vision' } })
    await waitFor(() =>
      expect(mockSetDefault).toHaveBeenCalledWith({
        selector: { purpose: 'vision' },
        profileId: 'p-vision',
      }),
    )
  })

  it('clears a default by choosing none (profileId null, never the empty string)', async () => {
    mockDefaults = [{ selector: { purpose: 'text' }, profileId: 'p-text' }]
    renderPage()
    const picker = await screen.findByLabelText('Default text profile')
    await waitFor(() => expect(picker).toHaveValue('p-text'))
    fireEvent.change(picker, { target: { value: '' } })
    await waitFor(() =>
      expect(mockSetDefault).toHaveBeenCalledWith({
        selector: { purpose: 'text' },
        profileId: null,
      }),
    )
  })

  /**
   * A default pointing at a DISABLED profile resolves to nothing at call time
   * — the picker must say so where it is set, not leave the operator to
   * discover it as a `no-profile` error inside another feature.
   */
  it('warns when the chosen default profile is disabled', async () => {
    mockProfiles = [profile({ enabled: false })]
    mockDefaults = [{ selector: { purpose: 'vision' }, profileId: 'p-vision' }]
    renderPage()
    expect(await screen.findByText(/this default profile is disabled/i)).toBeTruthy()
  })
})

describe('AiProfilesPage — the uniformity fixes', () => {
  beforeEach(() => {
    stubDialog()
    vi.clearAllMocks()
    mockProfiles = [profile()]
    mockDefaults = []
    mockKinds = [kind()]
  })

  /**
   * The tab strip used to be three plain buttons with the selection in React
   * state. A refresh, a deep link and the browser's back button all landed on
   * Profiles — which is exactly what `?tab=` exists to stop.
   */
  it('opens the tab named in the URL, not always the first one', async () => {
    renderPage('/system/ai?tab=usage')
    // Something only the Usage tab renders — the tab LABEL is present whichever
    // tab is open, so asserting on it would prove nothing.
    expect(await screen.findByText('No AI calls in this window.')).toBeTruthy()
    expect(screen.queryByLabelText('Default vision profile')).toBeNull()
  })

  it('renders the profile rows as a table with comparable columns', async () => {
    renderPage()
    expect(await screen.findByText('Mac LM-Studio Qwen3-VL 8B')).toBeTruthy()
    // The model was prose inside the row before; it is a column now.
    expect(screen.getByText('qwen/qwen3-vl-8b')).toBeTruthy()
  })

  /**
   * "Add profile" opened an inline card BELOW the list — off-screen on any
   * install with more than a handful of profiles. It is a modal dialog now, so
   * the assertion is on the element type, not on the text inside it.
   */
  it('opens the kind picker as a modal dialog, not an inline card', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Add profile'))
    const dialog = await screen.findByText('Choose a profile type')
    expect(dialog.closest('dialog')).not.toBeNull()
  })

  it('keeps the editor chrome outside the scrolling body', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Add profile'))
    // The kind label also appears in the table's Kind column, so scope the
    // click to the picker dialog rather than to the whole document.
    const picker = (await screen.findByText('Choose a profile type')).closest('dialog')
    expect(picker).not.toBeNull()
    fireEvent.click(within(picker!).getByText('OpenAI-compatible'))
    const title = await screen.findByText(/New OpenAI-compatible profile/)
    const dialog = title.closest('dialog')
    expect(dialog).not.toBeNull()
    // `scroll="body"` makes the dialog a non-scrolling flex column; the Save
    // row lives in the footer, a SIBLING of the scrolling body, so it cannot
    // travel with the fields.
    expect(dialog?.className).toContain('flex-col')
    const save = screen.getByText('Create profile')
    expect(save.closest('dialog')).toBe(dialog)
  })
})

describe('AiProfilesPage — the common admin page structure', () => {
  beforeEach(() => {
    stubDialog()
    vi.clearAllMocks()
    mockPresence = 'present'
    mockProfiles = [profile()]
    mockDefaults = []
    mockKinds = [kind()]
  })

  /**
   * D315: an unanswered registry read must never read as "not installed", and
   * an answered absence must say so instead of four tabs of failed calls.
   */
  it('renders a placeholder, not an absence, while the llm capability check is pending', async () => {
    mockPresence = 'pending'
    renderPage()
    expect(await screen.findByTestId('ai-presence-pending')).toBeTruthy()
    expect(screen.queryByText('AI is not installed')).toBeNull()
    expect(mockListProfiles).not.toHaveBeenCalled()
  })

  it('says AI is not installed only when the registry answered with no provider', async () => {
    mockPresence = 'absent'
    renderPage()
    expect(await screen.findByText('AI is not installed')).toBeTruthy()
    expect(screen.queryByText('Add profile')).toBeNull()
  })

  /** The Add button is a page-header action of the Profiles section only. */
  it('shows "Add profile" in the page header on Profiles and nowhere on other tabs', async () => {
    renderPage()
    const add = await screen.findByTestId('ai-add-profile')
    // Above the tab strip, not inside the section body.
    const tablist = screen.getByRole('tablist')
    expect(add.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByText('Runtimes'))
    await waitFor(() => expect(screen.queryByTestId('ai-add-profile')).toBeNull())
  })

  /**
   * The window picker lived in `AdminPage embedded`'s `actions`, which renders
   * nothing — it never appeared. It is in the Rollup card header now, and it
   * stays there when the window is empty.
   */
  it('renders the usage window picker even when the window has no calls', async () => {
    renderPage('/system/ai?tab=usage')
    expect(await screen.findByText('No AI calls in this window.')).toBeTruthy()
    expect(screen.getByLabelText('Window')).toBeTruthy()
  })

  it('asks before deleting a profile, and deletes nothing when declined', async () => {
    renderPage()
    fireEvent.click(await screen.findByLabelText('Delete'))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1))
    expect(mockDelete).not.toHaveBeenCalled()
    mockConfirm.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByLabelText('Delete'))
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith({ addonId: 'ai', profileId: 'p-vision' }),
    )
  })
})

/**
 * D893 — the editor is drawn from the descriptor and NOTHING else. A kind this
 * build has never heard of, from a provider that is not addon-ai, gets its
 * connection form, the model step and the save with no change to the page.
 */
const ACME: LlmProfileKindDescriptor = {
  kind: 'acme-llm',
  label: 'Acme LLM',
  icon: 'acme-logo',
  addonId: 'acme',
  connectionSchema: {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        fields: [
          { type: 'text', key: 'endpoint', label: 'Acme endpoint', required: true },
          { type: 'password', key: 'token', label: 'Acme token', showToggle: true },
        ],
      },
    ],
  },
  features: { vision: false, tools: true, streaming: false },
  visionEditable: true,
  modelCatalog: 'fetch',
  profileFields: ['temperature'],
}

/** The input a `ConfigFormBuilder` field draws under its label text. */
function fieldInput(dialog: HTMLElement, label: RegExp): HTMLElement {
  let node: HTMLElement | null = within(dialog).getAllByText(label)[0] ?? null
  while (node !== null && node.querySelector('input, textarea') === null) node = node.parentElement
  const input = node?.querySelector<HTMLElement>('input, textarea') ?? null
  if (input === null) throw new Error(`no input under ${String(label)}`)
  return input
}

async function openEditorFor(label: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText('Add profile'))
  const picker = (await screen.findByText('Choose a profile type')).closest('dialog')
  expect(picker).not.toBeNull()
  fireEvent.click(within(picker!).getByText(label))
  const title = await screen.findByText(new RegExp(`New ${label} profile`))
  const dialog = title.closest('dialog')
  expect(dialog).not.toBeNull()
  return dialog!
}

describe('AiProfilesPage — an open kind (D893)', () => {
  beforeEach(() => {
    stubDialog()
    vi.clearAllMocks()
    mockProfiles = []
    mockDefaults = []
    mockKinds = [kind(), ACME]
    mockListResult = {
      ok: true,
      models: [
        { id: 'acme-small', label: 'Acme Small' },
        { id: 'acme-vision', label: 'Acme Vision', features: { vision: true } },
      ],
    }
  })

  it('renders a third-party kind’s own connection form, lists its models from the DRAFT, saves providerConfig', async () => {
    renderPage()
    const dialog = await openEditorFor('Acme LLM')
    const endpoint = fieldInput(dialog, /Acme endpoint/)
    fireEvent.change(endpoint, { target: { value: 'https://acme.example.com' } })
    const token = fieldInput(dialog, /Acme token/)
    fireEvent.change(token, { target: { value: 'typed-token-0001' } })

    fireEvent.click(within(dialog).getByTestId('ai-verify-models'))
    await waitFor(() =>
      expect(mockListModels).toHaveBeenCalledWith({
        addonId: 'acme',
        kind: 'acme-llm',
        connection: { endpoint: 'https://acme.example.com', token: 'typed-token-0001' },
      }),
    )
    expect(await within(dialog).findByText('2 models found')).toBeTruthy()

    // The model's own feature overrides the kind default: vision turns on.
    fireEvent.change(within(dialog).getByLabelText('Select a model…'), {
      target: { value: 'acme-vision' },
    })
    fireEvent.click(within(dialog).getByText('Create profile'))
    await waitFor(() => expect(mockUpsert).toHaveBeenCalled())
    const saved = mockUpsert.mock.calls[0]?.[0].profile
    expect(saved).toMatchObject({
      kind: 'acme-llm',
      addonId: 'acme',
      model: 'acme-vision',
      supportsVision: true,
      providerConfig: { endpoint: 'https://acme.example.com', token: 'typed-token-0001' },
    })
  })

  it('a required provider field blocks the save until it is filled', async () => {
    renderPage()
    const dialog = await openEditorFor('Acme LLM')
    fireEvent.change(within(dialog).getByLabelText('Model id'), { target: { value: 'free-id' } })
    expect(within(dialog).getByText('Create profile').closest('button')).toBeDisabled()
    fireEvent.change(fieldInput(dialog, /Acme endpoint/), {
      target: { value: 'https://acme.example.com' },
    })
    expect(within(dialog).getByText('Create profile').closest('button')).not.toBeDisabled()
  })

  it('a failed listing is shown inline, with the provider’s reason', async () => {
    mockListResult = {
      ok: false,
      code: 'auth',
      message: 'the endpoint refused the credentials (HTTP 401)',
    }
    renderPage()
    const dialog = await openEditorFor('Acme LLM')
    fireEvent.click(within(dialog).getByTestId('ai-verify-models'))
    expect(
      await within(dialog).findByText('the endpoint refused the credentials (HTTP 401)'),
    ).toBeTruthy()
  })

  it('editing a saved profile lists with its id and the REDACTED key — the browser never holds the secret', async () => {
    mockProfiles = [
      profile({
        id: 'p-acme',
        name: 'Acme prod',
        kind: 'acme-llm',
        addonId: 'acme',
        model: 'acme-small',
        providerConfig: { endpoint: 'https://acme.example.com', token: '__redacted__' },
      }),
    ]
    renderPage()
    fireEvent.click(await screen.findByTitle('Edit'))
    const title = await screen.findByText(/Edit Acme prod/)
    const dialog = title.closest('dialog')!
    fireEvent.click(within(dialog).getByTestId('ai-verify-models'))
    await waitFor(() =>
      expect(mockListModels).toHaveBeenCalledWith({
        addonId: 'acme',
        kind: 'acme-llm',
        profileId: 'p-acme',
        connection: { endpoint: 'https://acme.example.com', token: '__redacted__' },
      }),
    )
  })

  it('opening a saved profile loads its models and features without a click', async () => {
    mockProfiles = [
      profile({
        id: 'p-acme',
        name: 'Acme prod',
        kind: 'acme-llm',
        addonId: 'acme',
        model: 'acme-vision',
        supportsVision: false,
        providerConfig: { endpoint: 'https://acme.example.com', token: '__redacted__' },
      }),
    ]
    renderPage()
    fireEvent.click(await screen.findByTitle('Edit'))
    const title = await screen.findByText(/Edit Acme prod/)
    const dialog = title.closest('dialog')!
    await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(1))
    expect(await within(dialog).findByText('2 models found')).toBeTruthy()
    // The listed model's own vision flag replaced the stale stored one.
    await waitFor(() =>
      expect(within(dialog).getByTestId('ai-model-features').textContent).toContain('vision'),
    )
  })

  it('typing a model id the list knows takes on that model’s features', async () => {
    renderPage()
    const dialog = await openEditorFor('Acme LLM')
    fireEvent.change(fieldInput(dialog, /Acme endpoint/), {
      target: { value: 'https://acme.example.com' },
    })
    fireEvent.change(fieldInput(dialog, /Acme token/), { target: { value: 'typed-token-0002' } })
    fireEvent.click(within(dialog).getByTestId('ai-verify-models'))
    expect(await within(dialog).findByText('2 models found')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Model id'), {
      target: { value: 'acme-vision' },
    })
    fireEvent.click(within(dialog).getByText('Create profile'))
    await waitFor(() => expect(mockUpsert).toHaveBeenCalled())
    expect(mockUpsert.mock.calls[0]?.[0].profile).toMatchObject({
      model: 'acme-vision',
      supportsVision: true,
    })
  })

  it('the provider header goes back to the pre-modal, never to another kind in place', async () => {
    renderPage()
    const dialog = await openEditorFor('Acme LLM')
    fireEvent.click(within(dialog).getByText('Change type'))
    expect(await screen.findByText('Choose a profile type')).toBeTruthy()
  })
})
