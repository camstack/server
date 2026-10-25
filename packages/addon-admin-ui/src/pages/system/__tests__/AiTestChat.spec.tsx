/**
 * The AI → Test tab, against a fake NDJSON stream.
 *
 * The properties asserted are the ones that broke in the field or would break
 * silently:
 *
 *  1. **It talks to the data plane, not tRPC.** The unary custom action failed
 *     with `UDS request timed out after 60000ms` on the operator's first use.
 *  2. **Tokens land as they arrive.** Asserted by holding the stream open
 *     mid-answer and checking the page already shows the partial text — the
 *     whole reason for the rewrite.
 *  3. **The image travels as a REFERENCE, under the key the addon expects.** A
 *     wrong key was silently stripped once and answered a vision question
 *     text-only.
 *  4. **Stop aborts the fetch**, so no orphan generation keeps a GPU warm.
 *  5. **Nothing is persisted.**
 */

import type { DeviceInfo, LlmProfile } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FleetListInput,
  type FleetListOptions,
  type FleetListResult,
  type FleetRow,
  fleetListResult,
} from './fleet-read-spy'

interface FetchCall {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown>
  readonly signal: AbortSignal | undefined
}

const fetchCalls: FetchCall[] = []

let listedChats: { id: string; title: string; updatedAt: number }[] = []
let storedChat: Record<string, unknown> | null = null

/** A controllable NDJSON response — the test releases each line by hand. */
function makeStream(): {
  readonly response: Response
  line: (event: Record<string, unknown>) => void
  close: () => void
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(body, { status: 200 }),
    line: (event) => controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
    close: () => controller?.close(),
  }
}

let nextResponse: () => Response | Promise<Response> = () => new Response('', { status: 200 })

const VISION_PROFILE: LlmProfile = {
  id: 'p-vision',
  name: 'Mac LM Studio',
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
}

const CAMERA: DeviceInfo = {
  id: 102,
  stableId: 'cam-102',
  addonId: 'rtsp',
  type: DeviceType.Camera,
  name: 'Uscio',
  location: null,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
}

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

/** The RAW tRPC fleet read. Named so the spec can assert it is never used. */
const mockListAllRaw = vi.fn(() => Promise.resolve([CAMERA]))

/** What the shared fleet query answers here — the same camera. */
const FLEET_ROWS: readonly FleetRow[] = [
  { id: CAMERA.id, name: CAMERA.name, type: 'camera', isCamera: true, disabled: false },
]

/** The generated fleet hook — the ONLY client this page may read the fleet
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
    useSystem: () => ({
      trpcClient: {
        llm: { listProfiles: { query: () => Promise.resolve([VISION_PROFILE]) } },
        deviceManager: { listAll: { query: mockListAllRaw } },
        pipelineAnalytics: {
          listRecentTracks: { query: () => Promise.resolve({ tracks: [], nextCursor: null }) },
        },
      },
    }),
  }
})

const { AiTestChatPage } = await import('../AiTestChat')

function renderChat(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AiTestChatPage />
    </QueryClientProvider>,
  )
}

async function pickProfile(): Promise<void> {
  const select = await screen.findByLabelText('Profile')
  await waitFor(() => expect(select.querySelector('option[value="p-vision"]')).not.toBeNull())
  fireEvent.change(select, { target: { value: 'p-vision' } })
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value } })
}

beforeEach(() => {
  fetchCalls.length = 0
  listedChats = []
  storedChat = null
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const rawBody = init.body
      fetchCalls.push({
        url,
        method,
        body: rawBody !== undefined ? (JSON.parse(String(rawBody)) as Record<string, unknown>) : {},
        signal: init.signal ?? undefined,
      })
      if (method === 'GET' && url === '/addon/ai/test-chat/chats') {
        return Promise.resolve(
          new Response(JSON.stringify({ chats: listedChats }), { status: 200 }),
        )
      }
      if (method === 'GET' && url.startsWith('/addon/ai/test-chat/chats/') && storedChat !== null) {
        return Promise.resolve(new Response(JSON.stringify(storedChat), { status: 200 }))
      }
      return Promise.resolve(nextResponse())
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AiTestChatPage — the transport', () => {
  it('POSTs the turn to the addon data plane, not to tRPC', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    expect(fetchCalls[0]!.url).toBe('/addon/ai/test-chat')
    expect(fetchCalls[0]!.body).toMatchObject({
      profileId: 'p-vision',
      messages: [{ role: 'user', content: 'ping' }],
    })
    stream.close()
  })

  /** THE reason this is a stream. */
  it('shows tokens while the answer is still arriving', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('what do you see?')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))

    stream.line({
      kind: 'meta',
      profileName: 'Mac LM Studio',
      model: 'qwen/qwen3-vl-8b',
      mediaSent: null,
      streamed: true,
      firstTokenTimeoutMs: 120_000,
    })
    stream.line({ kind: 'token', text: 'a white ' })
    // Still open: the stream has NOT ended and the page already shows the text.
    expect(await screen.findByText(/a white/)).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()

    stream.line({ kind: 'token', text: 'van' })
    expect(await screen.findByText(/a white van/)).toBeTruthy()

    stream.line({
      kind: 'done',
      inputTokens: 812,
      outputTokens: 4,
      latencyMs: 900,
      truncated: false,
    })
    stream.close()
    await waitFor(() => expect(screen.queryByText('Stop')).toBeNull())
  })

  /**
   * A cold GPU load and a wedged transport are the same silence. Naming the
   * phase is the entire difference, and it is what the 60 s failure lacked.
   */
  it('says the model may be loading, with the bound, while it waits', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))

    stream.line({
      kind: 'meta',
      profileName: 'Mac LM Studio',
      model: 'm',
      mediaSent: null,
      streamed: true,
      firstTokenTimeoutMs: 120_000,
    })
    stream.line({ kind: 'status', phase: 'first-token-wait' })
    expect(await screen.findByText(/cold load can take minutes \(up to 120s\)/)).toBeTruthy()
    stream.close()
  })

  /**
   * The cold-load fix, from the page's side.
   *
   * The addon now announces `first-token-wait` the moment the SOCKET is up —
   * BEFORE `meta`, and on a cold box minutes before it, because on the LM
   * Studio wire the response headers are what the model writes once it has
   * finished loading. If the page waited for `meta` to learn the bound it
   * would spend that whole wait saying "up to 0s".
   */
  it('quotes the profile bound while it waits, even before `meta` has arrived', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))

    // No `meta` — just the phase, exactly as a loading model produces it.
    stream.line({ kind: 'status', phase: 'first-token-wait' })
    expect(await screen.findByText(/cold load can take minutes \(up to 120s\)/)).toBeTruthy()
    expect(screen.queryByText(/up to 0s/)).toBeNull()
    stream.close()
  })

  /**
   * "Raise the first-token timeout" is the remedy the cold-load error names.
   * It is only true if the page sends the profile's own bound — before this it
   * sent nothing and the addon fell back to its built-in default, so the field
   * on the Profiles tab changed nothing here.
   */
  it("sends the profile's first-token bound so raising it actually does something", async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    expect(fetchCalls[0]!.body).toMatchObject({ firstTokenTimeoutMs: 120_000 })
    stream.close()
  })

  it('renders a server error as a failure, not as the model’s prose', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    stream.line({
      kind: 'error',
      code: 'unavailable',
      message: 'the endpoint did not accept the connection within 10s',
    })
    stream.close()
    expect(
      await screen.findByText(/unavailable: the endpoint did not accept the connection within 10s/),
    ).toBeTruthy()
  })

  it('surfaces a rejected request body instead of failing silently', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ error: 'invalid request', detail: 'imageRef: Unrecognized key' }),
        {
          status: 400,
        },
      )
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText(/Unrecognized key/)).toBeTruthy()
  })
})

describe('AiTestChatPage — the attachment', () => {
  /** By REFERENCE, and under the key `.strict()` on the addon expects. */
  it('sends the camera as {kind, deviceId} named `attachment` — no bytes', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    fireEvent.click(screen.getByText('Camera snapshot'))
    fireEvent.click(await screen.findByText('Uscio'))
    type('what do you see?')
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    const body = fetchCalls[0]!.body
    expect(body.attachment).toEqual({ kind: 'snapshot', deviceId: 102 })
    expect(body.imageRef).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/base64|data:image/i)
    stream.close()
  })

  it('shows what the operator attached and what the server says it sent', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    fireEvent.click(screen.getByText('Camera snapshot'))
    fireEvent.click(await screen.findByText('Uscio'))
    type('what do you see?')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))

    expect(screen.getByText('Snapshot of Uscio')).toBeTruthy()
    stream.line({
      kind: 'meta',
      profileName: 'Mac LM Studio',
      model: 'm',
      mediaSent: { kind: 'snapshot', mimeType: 'image/jpeg', sizeBytes: 120 * 1024 },
      streamed: true,
      firstTokenTimeoutMs: 120_000,
    })
    stream.line({ kind: 'token', text: 'a white van' })
    stream.line({ kind: 'done', inputTokens: 812, outputTokens: 4, latencyMs: 1, truncated: false })
    stream.close()
    expect(await screen.findByText(/camera snapshot · 120 KB/)).toBeTruthy()
  })
})

describe('AiTestChatPage — stop and clear', () => {
  /** No orphan generation may keep the GPU warm after the operator gives up. */
  it('aborts the fetch on Stop and keeps the half-answer on screen', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    stream.line({ kind: 'token', text: 'half an ans' })
    await screen.findByText(/half an ans/)

    fireEvent.click(screen.getByText('Stop'))
    await waitFor(() => expect(fetchCalls[0]!.signal?.aborted).toBe(true))
    // Evidence, not scratch — what it managed to say stays.
    expect(await screen.findByText(/half an ans/)).toBeTruthy()
  })

  it('clears the whole transcript and keeps nothing to restore it from', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    stream.line({ kind: 'token', text: 'pong' })
    stream.line({ kind: 'done', inputTokens: 1, outputTokens: 1, latencyMs: 1, truncated: false })
    stream.close()
    expect(await screen.findByText('pong')).toBeTruthy()

    fireEvent.click(screen.getByText('Clear'))
    await waitFor(() => expect(screen.queryByText('pong')).toBeNull())
    expect(screen.getByText(/Nothing here is saved/)).toBeTruthy()
    // One request, ever — no history endpoint refills the page.
    expect(fetchCalls).toHaveLength(1)
  })

  it('refuses to send with no profile chosen', async () => {
    renderChat()
    type('ping')
    expect(screen.getByText('Send').closest('button')).toBeDisabled()
  })
})

describe('AiTestChatPage — persistent chats', () => {
  it('throwaway POSTs without persist — nothing is written', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('ping')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    expect(fetchCalls[0]!.body.persist).toBeUndefined()
    stream.close()
  })

  it('Save conversation mode sends persist:true and lists the caller’s chats', async () => {
    listedChats = [{ id: 'c-1', title: 'What is parked', updatedAt: 1 }]
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    fireEvent.click(screen.getByText('Save conversation'))
    expect(await screen.findByText('What is parked')).toBeTruthy()
    await pickProfile()
    type('hello')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls.some((c) => c.body.persist === true)).toBe(true))
    stream.close()
  })

  it('renders the thumbnail of what was actually sent, live', async () => {
    const stream = makeStream()
    nextResponse = () => stream.response
    renderChat()
    await pickProfile()
    type('what is this?')
    fireEvent.click(screen.getByText('Send'))
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    stream.line({
      kind: 'meta',
      profileName: 'Mac LM Studio',
      model: 'm',
      mediaSent: {
        kind: 'snapshot',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        thumbnailBase64: Buffer.from('ABC').toString('base64'),
      },
      streamed: true,
      firstTokenTimeoutMs: 120_000,
    })
    stream.line({ kind: 'token', text: 'a van' })
    stream.line({ kind: 'done', inputTokens: 1, outputTokens: 1, latencyMs: 1, truncated: false })
    stream.close()
    const img = await screen.findByRole('img', { name: /sent to the model/i })
    expect(img.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('reopening a saved chat restores the transcript and the picture', async () => {
    listedChats = [{ id: 'c-1', title: 'what is this?', updatedAt: 1 }]
    storedChat = {
      id: 'c-1',
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          mediaSent: {
            kind: 'snapshot',
            mimeType: 'image/jpeg',
            sizeBytes: 3,
            thumbnailBase64: Buffer.from('ABC').toString('base64'),
          },
        },
        { role: 'assistant', content: 'a white van' },
      ],
    }
    renderChat()
    fireEvent.click(screen.getByText('Save conversation'))
    fireEvent.click(await screen.findByText('what is this?'))
    expect(await screen.findByText('a white van')).toBeTruthy()
    expect(screen.getByRole('img', { name: /sent to the model/i })).toBeTruthy()
  })
})

describe('the fleet read', () => {
  it('goes through the shared client, cameras-only and slim, never through the raw client', async () => {
    listAllHook.mockClear()
    mockListAllRaw.mockClear()
    renderChat()
    await pickProfile()
    // The camera picker only mounts once the operator asks to attach one.
    fireEvent.click(screen.getByText('Camera snapshot'))
    expect(await screen.findByText('Uscio')).toBeTruthy()
    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      // `isCamera` server-side: 30 rows instead of 1 019. Provably identical to
      // the client-side `d.isCamera` filter — the resolver applies exactly
      // `if (camerasOnly && !info.isCamera) continue`.
      expect(input?.isCamera).toBe(true)
      expect(input?.projection).toBe('slim')
      // D274 owns the window on the query client.
      expect(options?.staleTime).toBeUndefined()
    }
    // The raw client is the hole D274 does not close.
    expect(mockListAllRaw).not.toHaveBeenCalled()
  })
})
