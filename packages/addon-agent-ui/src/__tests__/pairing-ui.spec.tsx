/**
 * The agent UI's pairing screens (D857): unpaired, a request pending (away from
 * the agent and on it), paired, and locked out - and the deprecated cluster
 * secret / join token / hub picker are gone.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus } from '../agent-status'
import { discoveredLabel } from '../agent-status'
import { AGENT_SESSION_STORAGE_KEY, authHeaders } from '../api-client'
import { HubConfigPanel } from '../hub-config-panel'
import type { PairingStatusView } from '../pairing-api'

const HUB = {
  nodeId: 'hub',
  url: 'https://192.0.2.10:4443',
  caFingerprint: 'aabbccddeeff0011',
}
const OTHER = {
  nodeId: 'lab-hub',
  url: 'https://192.168.1.77:4443',
  caFingerprint: '1122334455667788',
}
const EXPIRES = Date.now() + 5 * 60_000

const REMOTE_PENDING: PairingStatusView = {
  state: 'pending',
  pending: [{ hub: HUB, expiresAt: EXPIRES }],
}
const LOCAL_PENDING: PairingStatusView = {
  state: 'pending',
  pending: [
    {
      hub: HUB,
      expiresAt: EXPIRES,
      pairingId: 'pid-1',
      pin: '12345678',
      localConfirmed: false,
    },
  ],
}

interface Call {
  readonly url: string
  readonly body: Record<string, unknown> | null
}

let pairingView: PairingStatusView
let answers: Record<string, { status: number; body: unknown }>
let calls: Call[]

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body === undefined ? null : JSON.parse(init.body)
      calls.push({ url, body })
      if (url.endsWith('/pairing/status')) {
        return { ok: true, status: 200, json: async () => pairingView }
      }
      const answer = answers[url] ?? { status: 200, body: { ok: true } }
      return {
        ok: answer.status < 400,
        status: answer.status,
        json: async () => answer.body,
      }
    }),
  )
}

const status: AgentStatus = {
  nodeId: 'agent-1',
  name: 'agent-1',
  platform: 'linux',
  arch: 'x64',
  hostname: 'box',
  cpuCores: 2,
  totalMemoryMB: 1000,
  freeMemoryMB: 500,
  cpuPercent: 0,
  memoryPercent: 0,
  uptime: 10,
  localIps: [],
  addons: [],
  hubAddress: null,
  hubConnectionState: 'unconfigured',
  paired: false,
}

function mount(overrides: Partial<AgentStatus> = {}): void {
  render(
    <HubConfigPanel status={{ ...status, ...overrides }} onStatusRefresh={async () => undefined} />,
  )
}

const confirmCall = (): Call | undefined => calls.find((c) => c.url.endsWith('/pairing/confirm'))

// jsdom has no modal <dialog>: open/close it the way the library expects.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
  }
})

beforeEach(() => {
  pairingView = { state: 'unpaired', pending: [] }
  answers = {}
  calls = []
  stubFetch()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('unpaired, nothing pending', () => {
  it('says how a pairing starts, and offers neither a code nor a PIN', async () => {
    mount()
    expect(await screen.findByText(/start pairing; the request appears here/)).toBeTruthy()
    expect(screen.queryByLabelText(/Code shown on the hub/)).toBeNull()
    expect(screen.queryByLabelText(/Local PIN/)).toBeNull()
  })
})

describe('an unpaired agent seen from the network (status is locked)', () => {
  it('shows the pairing panel as Not paired, never as a disconnected hub', async () => {
    pairingView = REMOTE_PENDING
    render(<HubConfigPanel status={null} onStatusRefresh={async () => undefined} />)
    expect(await screen.findByText('aabb ccdd eeff 0011')).toBeTruthy()
    expect(screen.getAllByText('Not paired').length).toBeGreaterThan(0)
    expect(screen.queryByText('Disconnected')).toBeNull()
  })
})

describe('a certificate the hub refused', () => {
  it('says to forget the hub and pair again', async () => {
    pairingView = { state: 'paired', pending: [] }
    mount({ paired: true, hubConnectionState: 'certificate-rejected' })
    expect(await screen.findByText('Certificate rejected')).toBeTruthy()
    expect(screen.getByText(/refused this agent's certificate/)).toBeTruthy()
  })
})

describe('a pairing request away from the agent', () => {
  beforeEach(() => {
    pairingView = REMOTE_PENDING
  })

  it('names the hub, its url and its CA fingerprint, with a countdown', async () => {
    mount()
    expect(await screen.findByText('hub')).toBeTruthy()
    expect(screen.getByText('https://192.0.2.10:4443')).toBeTruthy()
    expect(screen.getByText('aabb ccdd eeff 0011')).toBeTruthy()
    expect(screen.getByTitle('Time left to confirm').textContent).toMatch(/^[0-4]:\d\d$|^5:00$/)
  })

  it('asks for the hub code and the local PIN, both empty and explained', async () => {
    mount()
    const code = (await screen.findByLabelText(/Code shown on the hub/)) as HTMLInputElement
    const pin = screen.getByLabelText(/Local PIN/) as HTMLInputElement
    expect(code.value).toBe('')
    expect(pin.value).toBe('')
    expect(document.body.textContent).toMatch(/pairing-pin\.txt/)
    expect(document.body.textContent).toMatch(/docker logs/)
  })

  it('confirms only with a full code and a full PIN, and sends both', async () => {
    mount()
    const code = await screen.findByLabelText(/Code shown on the hub/)
    const pin = screen.getByLabelText(/Local PIN/)
    const confirm = screen.getByText('Confirm').closest('button') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(code, { target: { value: '123456' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(pin, { target: { value: '87654321' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(confirmCall()).toBeDefined())
    expect(confirmCall()?.body).toEqual({ pin: '87654321', code: '123456' })
  })

  it("shows the server's wrong-code message and clears the typed code", async () => {
    answers['/api/agent/pairing/confirm'] = {
      status: 403,
      body: {
        ok: false,
        error: 'code-mismatch',
        message: 'that is not the code this agent computed',
      },
    }
    mount()
    const code = (await screen.findByLabelText(/Code shown on the hub/)) as HTMLInputElement
    fireEvent.change(screen.getByLabelText(/Local PIN/), {
      target: { value: '87654321' },
    })
    fireEvent.change(code, { target: { value: '000000' } })
    fireEvent.click(screen.getByText('Confirm'))
    expect(await screen.findByText(/that is not the code this agent computed/)).toBeTruthy()
    expect(code.value).toBe('')
  })

  it('after a confirmation shows the code the network confirm returned, to type on the hub', async () => {
    answers['/api/agent/pairing/confirm'] = { status: 200, body: { ok: true, code: '851937' } }
    mount()
    fireEvent.change(await screen.findByLabelText(/Code shown on the hub/), {
      target: { value: '123456' },
    })
    fireEvent.change(screen.getByLabelText(/Local PIN/), {
      target: { value: '87654321' },
    })
    fireEvent.click(screen.getByText('Confirm'))
    expect(await screen.findByText('Confirmed on this agent')).toBeTruthy()
    expect(screen.getByTestId('agent-pairing-own-code').textContent).toBe('851 937')
    expect(screen.queryByLabelText(/Code shown on the hub/)).toBeNull()
  })

  it('shows no own code before the local confirmation', async () => {
    mount()
    await screen.findByLabelText(/Code shown on the hub/)
    expect(screen.queryByTestId('agent-pairing-own-code')).toBeNull()
    expect(screen.queryByText(/Code on this agent/)).toBeNull()
  })

  it('rejects with the PIN', async () => {
    mount()
    fireEvent.change(await screen.findByLabelText(/Local PIN/), {
      target: { value: '87654321' },
    })
    fireEvent.click(screen.getByText('Reject'))
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/pairing/reject'))?.body).toEqual({
        pin: '87654321',
      }),
    )
  })

  it('locks confirming while the server rations wrong PINs, and says for how long', async () => {
    answers['/api/agent/pairing/confirm'] = {
      status: 429,
      body: {
        ok: false,
        error: 'pin-locked',
        message: 'too many wrong PINs - try again later',
        retryAfterMs: 120_000,
      },
    }
    mount()
    fireEvent.change(await screen.findByLabelText(/Code shown on the hub/), {
      target: { value: '123456' },
    })
    fireEvent.change(screen.getByLabelText(/Local PIN/), {
      target: { value: '00000000' },
    })
    fireEvent.click(screen.getByText('Confirm'))
    expect(await screen.findByText('Confirming is locked')).toBeTruthy()
    expect(screen.getByText(/Try again in 2 min/)).toBeTruthy()
  })

  it('lists several pending hubs, and a code typed for one is not carried to another', async () => {
    pairingView = {
      state: 'pending',
      pending: [
        { hub: HUB, expiresAt: EXPIRES },
        { hub: OTHER, expiresAt: EXPIRES },
      ],
    }
    mount()
    const code = (await screen.findByLabelText(/Code shown on the hub/)) as HTMLInputElement
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    fireEvent.change(code, { target: { value: '123456' } })
    fireEvent.click(screen.getByText(/lab-hub · https:\/\/192\.168\.1\.77:4443/))
    expect((screen.getByLabelText(/Code shown on the hub/) as HTMLInputElement).value).toBe('')
    expect(screen.getByText('1122 3344 5566 7788')).toBeTruthy()
  })
})

describe('a pairing request on the agent itself', () => {
  beforeEach(() => {
    pairingView = LOCAL_PENDING
  })

  it('hides the PIN field, never shows the PIN, and still leaves the code empty', async () => {
    mount()
    const code = (await screen.findByLabelText(/Code shown on the hub/)) as HTMLInputElement
    expect(code.value).toBe('')
    expect(screen.queryByLabelText(/Local PIN/)).toBeNull()
    expect(document.body.textContent).not.toContain('12345678')
  })

  it('confirms without the operator typing a PIN', async () => {
    mount()
    fireEvent.change(await screen.findByLabelText(/Code shown on the hub/), {
      target: { value: '654321' },
    })
    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => expect(confirmCall()).toBeDefined())
    expect(confirmCall()?.body).toEqual({ pin: '12345678', code: '654321' })
  })

  it('shows no own code while the loopback status has not confirmed yet', async () => {
    pairingView = {
      state: 'pending',
      pending: [{ ...(LOCAL_PENDING.pending[0] as object), code: null } as never],
    }
    mount()
    await screen.findByLabelText(/Code shown on the hub/)
    expect(screen.queryByTestId('agent-pairing-own-code')).toBeNull()
  })

  it('reflects a confirmation already made here and shows the agent code from the status', async () => {
    pairingView = {
      state: 'pending',
      pending: [
        {
          ...(LOCAL_PENDING.pending[0] as object),
          localConfirmed: true,
          code: '851937',
        } as never,
      ],
    }
    mount()
    expect(await screen.findByText('Confirmed on this agent')).toBeTruthy()
    expect(screen.getByTestId('agent-pairing-own-code').textContent).toBe('851 937')
  })
})

describe('reset pairing lockout', () => {
  it('asks for the reset code away from the agent and says where it is', async () => {
    pairingView = REMOTE_PENDING
    vi.stubGlobal('location', { ...window.location, hostname: '192.0.2.20' })
    mount()
    fireEvent.click(await screen.findByText('Reset pairing lockout'))
    expect(screen.getByLabelText(/Reset code/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/pairing-reset\.txt/)
    fireEvent.change(screen.getByLabelText(/Reset code/), {
      target: { value: '99887766' },
    })
    fireEvent.click(screen.getByText('Reset pairing'))
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/pairing/reset'))?.body).toEqual({
        code: '99887766',
      }),
    )
  })

  it('asks for the code after all when the agent does not see this page as local', async () => {
    pairingView = { state: 'unpaired', pending: [] }
    answers['/api/agent/pairing/reset'] = {
      status: 401,
      body: {
        ok: false,
        error: 'reset-code-required',
        message: 'the reset code printed on the agent is required',
      },
    }
    mount()
    fireEvent.click(await screen.findByText('Reset pairing lockout'))
    fireEvent.click(screen.getByText('Reset pairing'))
    expect(await screen.findByLabelText('Reset code')).toBeTruthy()
  })

  it('needs no code on the agent itself', async () => {
    pairingView = LOCAL_PENDING
    mount()
    fireEvent.click(await screen.findByText('Reset pairing lockout'))
    expect(screen.queryByLabelText(/Reset code/)).toBeNull()
    fireEvent.click(screen.getByText('Reset pairing'))
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/pairing/reset'))?.body).toEqual({}),
    )
  })
})

describe('paired', () => {
  beforeEach(() => {
    pairingView = { state: 'paired', pending: [] }
  })

  it('shows the hub it is paired with and offers Forget this hub behind a confirm', async () => {
    mount({
      paired: true,
      hubConnectionState: 'connected',
      hubAddress: '192.0.2.10',
      pairedHub: {
        url: 'https://192.0.2.10:4443',
        caFingerprint: 'aabbccddeeff0011',
      },
    })
    expect(await screen.findByText('https://192.0.2.10:4443')).toBeTruthy()
    expect(screen.getByText('aabb ccdd eeff 0011')).toBeTruthy()
    fireEvent.click(screen.getByText('Forget this hub'))
    expect(await screen.findByText('Forget this hub?')).toBeTruthy()
    expect(calls.some((c) => c.url.endsWith('/pairing/forget'))).toBe(false)
    fireEvent.click(screen.getByText('Forget hub'))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/pairing/forget'))).toBe(true))
  })

  it('offers no pairing form and no reset', async () => {
    mount({ paired: true, pairedHub: null })
    await screen.findByText('Forget this hub')
    expect(screen.queryByLabelText(/Code shown on the hub/)).toBeNull()
    expect(screen.queryByText('Reset pairing lockout')).toBeNull()
  })
})

describe('an agent that predates pairing', () => {
  it('says to update it instead of showing a form that cannot work', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    )
    mount()
    expect(await screen.findByText(/too old to pair from here/)).toBeTruthy()
  })
})

describe('the deprecated join is gone', () => {
  it.each([
    ['unpaired', { state: 'unpaired', pending: [] } as PairingStatusView],
    ['pending', REMOTE_PENDING],
    ['paired', { state: 'paired', pending: [] } as PairingStatusView],
  ])('shows no secret, token, hub picker or address field when %s', async (_name, view) => {
    pairingView = view
    mount({ paired: view.state === 'paired' })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    fireEvent.click(await screen.findByText('Rename agent'))
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/cluster secret|join token|secret mismatch|Choose a hub/i)
    expect(screen.queryByLabelText(/Hub Address/)).toBeNull()
    expect(screen.queryByText('Search again')).toBeNull()
    expect(screen.getByLabelText('Agent Name')).toBeTruthy()
  })

  it('has no cluster secret Bearer fallback', () => {
    sessionStorage.setItem('camstack_agent_ui_secret', 'old-secret')
    expect(authHeaders()).toEqual({})
    sessionStorage.setItem(AGENT_SESSION_STORAGE_KEY, 'tab-session')
    expect(authHeaders()).toEqual({ Authorization: 'Bearer tab-session' })
  })
})

describe('naming the hub', () => {
  const hub = {
    id: 'hub',
    hostname: 'a4afbe756e45',
    displayName: 'a4afbe756e45',
    isHub: true,
  }

  it('never labels the hub with its container id when its address is known', () => {
    expect(discoveredLabel(hub, '192.0.2.10')).toBe('192.0.2.10 (hub)')
  })

  it('keeps a hostname an operator chose, and a display name that is an address', () => {
    expect(discoveredLabel({ ...hub, displayName: 'unraid' }, '192.0.2.10')).toBe('unraid (hub)')
    expect(discoveredLabel({ ...hub, displayName: '192.0.2.10' }, null)).toBe('192.0.2.10 (hub)')
  })
})
