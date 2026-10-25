/**
 * AlexaLoginStep — start→poll→captured→commit→onResolved lifecycle tests.
 *
 * Mocks the three fetch endpoints:
 *   POST /addon/import-alexa/login/start
 *   GET  /addon/import-alexa/login/status
 *   POST /addon/import-alexa/login/commit
 *
 * Verifies:
 *   - start triggers a POST with the selected amazonDomain and Bearer auth
 *   - polling transitions the UI through starting → awaiting-login
 *   - on `captured` phase the component auto-commits and calls onResolved
 *   - onResolved is called with the broker id from /login/commit
 *   - Authorization header carries the token from localStorage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AlexaLoginStep } from '../AlexaLoginStep'

const FAKE_TOKEN = 'test-admin-token-xyz'
const FAKE_SESSION_ID = 'sess-abc123'
const FAKE_LOGIN_URL = 'http://hub:8888/amazon-login'
const FAKE_BROKER_ID = 'alexa-broker-001'

// ── fetch mock helpers ─────────────────────────────────────────────────────────
interface CallRecord {
  url: string
  options: RequestInit
}

const calls: CallRecord[] = []

// Poll responses cycle through the sequence on each GET /login/status call.
const statusSequence: Array<{ phase: string; loginUrl: string; error: null | string }> = []

function setupFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      calls.push({ url: String(url), options })

      const urlStr = String(url)

      if (urlStr.includes('/login/start')) {
        return new Response(
          JSON.stringify({
            sessionId: FAKE_SESSION_ID,
            loginUrl: FAKE_LOGIN_URL,
            amazonDomain: 'amazon.it',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (urlStr.includes('/login/status')) {
        const next = statusSequence.shift() ?? {
          phase: 'awaiting-login',
          loginUrl: FAKE_LOGIN_URL,
          error: null,
        }
        return new Response(
          JSON.stringify({
            sessionId: FAKE_SESSION_ID,
            loginUrl: next.loginUrl,
            amazonDomain: 'amazon.it',
            phase: next.phase,
            error: next.error,
            startedAt: Date.now(),
            capturedAt: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (urlStr.includes('/login/commit')) {
        return new Response(JSON.stringify({ brokerId: FAKE_BROKER_ID }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (urlStr.includes('/login/cancel')) {
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response('not found', { status: 404 })
    }),
  )
}

// ── helpers ────────────────────────────────────────────────────────────────────
/** Flush all pending microtasks / Promise continuations. */
async function flushPromises(): Promise<void> {
  // Multiple rounds to let chained awaits settle.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  calls.length = 0
  statusSequence.length = 0
  localStorage.setItem('camstack_admin_token', FAKE_TOKEN)
  setupFetch()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.removeItem('camstack_admin_token')
})

// ── Tests ──────────────────────────────────────────────────────────────────────
describe('AlexaLoginStep', () => {
  it('renders in idle state with Start login button', () => {
    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: /start login/i })).toBeTruthy()
  })

  it('label htmlFor wires to the account name input', () => {
    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)
    const input = document.getElementById('alexa-account-name')
    expect(input).toBeTruthy()
    const label = document.querySelector('label[for="alexa-account-name"]')
    expect(label).toBeTruthy()
  })

  it('label htmlFor wires to the amazon region select', () => {
    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)
    const select = document.getElementById('alexa-amazon-region')
    expect(select).toBeTruthy()
    const label = document.querySelector('label[for="alexa-amazon-region"]')
    expect(label).toBeTruthy()
  })

  it('POSTs /login/start with Bearer token', async () => {
    // Let start resolve, then let the first poll interval fire returning 'awaiting-login'.
    statusSequence.push({ phase: 'awaiting-login', loginUrl: FAKE_LOGIN_URL, error: null })

    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)

    // Click Start login and flush the POST promise.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start login/i }))
      await flushPromises()
    })

    const startCall = calls.find((c) => c.url.includes('/login/start'))
    expect(startCall).toBeTruthy()
    const startHeaders = startCall?.options.headers as Record<string, string>
    expect(startHeaders['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`)
  })

  it('full lifecycle: start→poll awaiting-login→poll captured→commit→onResolved', async () => {
    // Two poll ticks: first returns awaiting-login (shows the link), second captured (auto-commits).
    statusSequence.push(
      { phase: 'awaiting-login', loginUrl: FAKE_LOGIN_URL, error: null },
      { phase: 'captured', loginUrl: FAKE_LOGIN_URL, error: null },
    )

    const onResolved = vi.fn()
    render(<AlexaLoginStep onResolved={onResolved} onCancel={vi.fn()} />)

    // Start the flow and wait for the POST to resolve + state update.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start login/i }))
      await flushPromises()
    })

    // First poll tick → 'awaiting-login' → shows Login to Amazon link.
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await flushPromises()
    })

    // The Amazon login link is visible.
    expect(screen.getByRole('link', { name: /login to amazon/i })).toBeTruthy()

    // Second poll tick → 'captured' → commit fires → onResolved called.
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await flushPromises()
    })

    expect(onResolved).toHaveBeenCalledWith(FAKE_BROKER_ID)

    // Commit call must carry Bearer auth.
    const commitCall = calls.find((c) => c.url.includes('/login/commit'))
    expect(commitCall).toBeTruthy()
    const commitHeaders = commitCall?.options.headers as Record<string, string>
    expect(commitHeaders['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`)
  })

  it('shows error banner when /login/status returns error phase', async () => {
    statusSequence.push({ phase: 'error', loginUrl: FAKE_LOGIN_URL, error: 'Proxy failed' })

    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start login/i }))
      await flushPromises()
    })

    // First poll tick → 'error' → error banner.
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await flushPromises()
    })

    expect(screen.getByText('Proxy failed')).toBeTruthy()
  })

  it('calls onCancel when Back is clicked in idle state', () => {
    const onCancel = vi.fn()
    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('hides account-name input in re-link mode (brokerId provided)', () => {
    render(<AlexaLoginStep brokerId="existing-broker" onResolved={vi.fn()} onCancel={vi.fn()} />)
    // Account name field is hidden when brokerId is set.
    expect(document.getElementById('alexa-account-name')).toBeNull()
    // Start login is still present and enabled.
    const startBtn = screen.getByRole('button', { name: /start login/i })
    expect((startBtn as HTMLButtonElement).disabled).toBe(false)
  })

  it('GET /login/status carries Bearer auth', async () => {
    statusSequence.push({ phase: 'awaiting-login', loginUrl: FAKE_LOGIN_URL, error: null })

    render(<AlexaLoginStep onResolved={vi.fn()} onCancel={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start login/i }))
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await flushPromises()
    })

    const statusCall = calls.find((c) => c.url.includes('/login/status'))
    expect(statusCall).toBeTruthy()
    const statusHeaders = statusCall?.options.headers as Record<string, string>
    expect(statusHeaders['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`)
  })
})
