/**
 * `BrokerSignInPanel`: the method selector appears only for a kind that serves
 * more than one method, the first listed is the default, and the device-code
 * flow shows the code and the verification link and commits on `captured`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrokerSignInPanel } from '../BrokerSignInPanel'

const BASE = '/addon/some-addon/login'

function stubRoutes(phase: string): ReturnType<typeof vi.fn> {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/code/start'))
      return json({
        sessionId: 's1',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://site.example/code',
        expiresAt: Date.now() + 300_000,
      })
    if (url.includes('/status'))
      return json({
        sessionId: 's1',
        phase,
        userCode: 'ABCD-1234',
        verificationUrl: 'https://site.example/code',
        expiresAt: Date.now() + 300_000,
        error: null,
      })
    if (url.endsWith('/commit')) return json({ brokerId: 'b1' })
    return json({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const props = {
  basePath: BASE,
  name: 'Home',
  getSettings: () => ({ amazonDomain: 'amazon.it' }),
  onSignedIn: vi.fn(),
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrokerSignInPanel', () => {
  it('shows no selector for a single method (absent = proxy only)', () => {
    render(<BrokerSignInPanel {...props} />)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByTestId('device-code')).toBeNull()
  })

  it('shows a selector for two methods and defaults to the first', () => {
    render(<BrokerSignInPanel {...props} methods={['device-code', 'proxy']} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
  })

  it('renders the code and link, then commits when captured', async () => {
    const fetchMock = stubRoutes('captured')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const onSignedIn = vi.fn()
    render(
      <BrokerSignInPanel {...props} onSignedIn={onSignedIn} methods={['device-code', 'proxy']} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /get a code/i }))
    await waitFor(() => expect(screen.getByTestId('device-code').textContent).toBe('ABCD-1234'))
    fireEvent.click(screen.getByRole('button', { name: /open site.example/i }))
    expect(open).toHaveBeenCalledWith('https://site.example/code', '_blank', 'noopener,noreferrer')
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('b1'), { timeout: 4000 })
    const started = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/code/start'))
    expect(started).toBeDefined()
  })

  it('offers a new code when expired', async () => {
    stubRoutes('expired')
    render(<BrokerSignInPanel {...props} methods={['device-code']} />)
    fireEvent.click(screen.getByRole('button', { name: /get a code/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /new code/i })).toBeTruthy(), {
      timeout: 4000,
    })
  })
})
