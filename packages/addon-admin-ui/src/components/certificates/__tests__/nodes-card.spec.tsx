// @vitest-environment jsdom
/**
 * Identity → Certificates → Nodes (HTTPS + cluster identity in one table):
 * reading ≠ failed ≠ empty (D315), an uploaded hub certificate cannot be
 * renewed from the button, a failed identity renewal names its stage, and
 * revoking an identity goes through the confirm.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

interface QueryState {
  data?: unknown
  isPending: boolean
  error: { message: string } | null
}

const h = vi.hoisted(() => {
  const state: Record<string, QueryState> = {}
  const mutations: Record<string, Mock<(vars: unknown) => void>> = {}
  const confirmSpy = vi.fn()
  const flags = { confirmAnswer: true, renewResult: null as unknown }
  const query = (key: string) => () => {
    const base: QueryState = { isPending: false, error: null }
    return { ...base, refetch: vi.fn(), ...state[key] }
  }
  const mutation = (key: string) => () => ({
    mutate: (vars: unknown) => {
      ;(mutations[key] ??= vi.fn())(vars)
    },
    isPending: false,
    variables: undefined,
    reset: vi.fn(),
  })
  return { state, mutations, confirmSpy, flags, query, mutation }
})
const { state, mutations, confirmSpy, flags } = h

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useConfirm: () => async (opts: unknown) => {
      confirmSpy(opts)
      return flags.confirmAnswer
    },
    usePrompt: () => async () => null,
    useUserManagementListUsers: () => ({ data: [] }),
    useLocalNetworkGetTlsStatus: () => ({ data: undefined }),
    trpc: {
      useUtils: () => ({
        certificates: {
          listHttpsCertificates: { invalidate: vi.fn() },
          getMeshCertificates: { invalidate: vi.fn() },
        },
      }),
      certificates: {
        listHttpsCertificates: { useQuery: h.query('https') },
        getMeshCertificates: { useQuery: h.query('mesh') },
        renewHttpsOnNode: { useMutation: h.mutation('renewHttps') },
        revokeMeshOnNode: { useMutation: h.mutation('revokeMesh') },
        renewMeshOnNode: {
          useMutation: (opts: { onSuccess: (r: unknown) => void }) => ({
            mutate: () => opts.onSuccess(flags.renewResult),
            isPending: false,
            variables: undefined,
          }),
        },
      },
    },
  }
})

import { NodesCard } from '../NodesCard'

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k]
  for (const k of Object.keys(mutations)) delete mutations[k]
  flags.confirmAnswer = true
  confirmSpy.mockClear()
  state['https'] = { isPending: false, error: null, data: [] }
  state['mesh'] = { isPending: false, error: null, data: emptyMesh }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const emptyMesh = {
  ca: {
    state: 'ready',
    subject: 'CN=CA',
    fingerprintSha256: 'AA',
    validTo: 'Oct 9 2035 GMT',
  },
  revokedSerials: [],
  registryAvailable: true,
  listener: { state: 'open' },
  nodes: [],
}

const hubRow = (mode: 'uploaded' | 'generated') => ({
  nodeId: 'hub',
  isHub: true,
  online: true,
  https: {
    kind: 'served',
    status: {
      mode,
      leafFingerprintSha256: 'AA:BB',
      caFingerprintSha256: null,
      validTo: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      sans: ['hub.example.com'],
      reissueError: null,
      restartRequired: false,
    },
  },
})

describe('NodesCard - HTTPS', () => {
  it('says reading while pending, never "no nodes"', () => {
    state['https'] = { isPending: true, error: null }
    render(<NodesCard />)
    expect(screen.getByTestId('query-pending')).toBeTruthy()
    expect(screen.queryByText('No nodes reported.')).toBeNull()
  })

  it('shows the failure with its reason', () => {
    state['https'] = { isPending: false, error: { message: 'boom' } }
    render(<NodesCard />)
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('says nothing was reported only for an answered empty list', () => {
    state['https'] = { isPending: false, error: null, data: [] }
    render(<NodesCard />)
    expect(screen.getByText('No nodes reported.')).toBeTruthy()
  })

  it('shows no Renew button on an uploaded hub certificate, only the note', () => {
    state['https'] = {
      isPending: false,
      error: null,
      data: [hubRow('uploaded')],
    }
    render(<NodesCard />)
    expect(screen.queryByRole('button', { name: /Renew the certificate on hub/ })).toBeNull()
    expect(screen.getByTestId('hub-managed-note').textContent).toBe('Managed by the hub')
  })

  it('renews a generated certificate after the confirm', async () => {
    state['https'] = {
      isPending: false,
      error: null,
      data: [hubRow('generated')],
    }
    render(<NodesCard />)
    fireEvent.click(screen.getByRole('button', { name: /Renew the certificate on hub/ }))
    await waitFor(() => expect(mutations['renewHttps']).toHaveBeenCalledWith({ nodeId: 'hub' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })
})

const agentMesh = {
  ca: {
    state: 'ready',
    subject: 'CN=CA',
    fingerprintSha256: 'AA',
    validTo: 'Oct 9 2035 GMT',
  },
  revokedSerials: [],
  registryAvailable: true,
  listener: { state: 'open' },
  nodes: [
    {
      nodeId: 'agent-1',
      online: true,
      current: {
        serial: '4F2A9C1D7E3B5A60',
        fingerprintSha256: 'AA:BB',
        notBefore: 0,
        notAfter: Date.now() + 200 * 86_400_000,
        issuedAt: 0,
        issuedVia: 'enroll',
        status: 'valid',
        revokedAt: null,
        revokedReason: null,
      },
      presentingCurrent: true,
      history: [],
    },
  ],
}

describe('NodesCard - cluster identity', () => {
  it('shows pending, failure and an answer differently', () => {
    state['mesh'] = { isPending: true, error: null }
    const { unmount } = render(<NodesCard />)
    expect(screen.getByTestId('query-pending')).toBeTruthy()
    unmount()
    state['mesh'] = { isPending: false, error: { message: 'no registry' } }
    render(<NodesCard />)
    expect(screen.getByText('no registry')).toBeTruthy()
  })

  it('revokes only after the confirm, which says the node must re-join', async () => {
    state['mesh'] = { isPending: false, error: null, data: agentMesh }
    render(<NodesCard />)
    flags.confirmAnswer = false
    fireEvent.click(
      screen.getByRole('button', {
        name: /Revoke the cluster certificate of agent-1/,
      }),
    )
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(mutations['revokeMesh']).toBeUndefined()
    expect(JSON.stringify(confirmSpy.mock.calls[0])).toContain('paired again')

    flags.confirmAnswer = true
    fireEvent.click(
      screen.getByRole('button', {
        name: /Revoke the cluster certificate of agent-1/,
      }),
    )
    await waitFor(() =>
      expect(mutations['revokeMesh']).toHaveBeenCalledWith({
        nodeId: 'agent-1',
      }),
    )
  })

  it('shows no action buttons on the hub row, only a managed-by-hub note', () => {
    state['mesh'] = {
      isPending: false,
      error: null,
      data: {
        ...agentMesh,
        nodes: [
          {
            nodeId: 'hub',
            online: true,
            current: null,
            presentingCurrent: null,
            history: [],
          },
        ],
      },
    }
    render(<NodesCard />)
    expect(screen.queryByRole('button', { name: /of hub/ })).toBeNull()
    expect(screen.queryByTestId('mesh-reason-hub')).toBeNull()
    expect(screen.getByTestId('hub-managed-note').textContent).toBe('Managed by the hub')
  })

  it('names the stage when a renewal fails', async () => {
    state['mesh'] = { isPending: false, error: null, data: agentMesh }
    flags.renewResult = {
      ok: false,
      nodeId: 'agent-1',
      stage: 'install',
      reason: 'disk full',
      keptPreviousLeaf: true,
    }
    render(<NodesCard />)
    fireEvent.click(
      screen.getByRole('button', {
        name: /Renew the cluster certificate of agent-1/,
      }),
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('installing it on the node')
    expect(alert.textContent).toContain('disk full')
  })
})

describe('NodesCard - one row per node', () => {
  it('joins the HTTPS and the identity certificate of a node into a single row', () => {
    state['https'] = {
      isPending: false,
      error: null,
      data: [{ ...hubRow('generated'), nodeId: 'agent-1', isHub: false }],
    }
    state['mesh'] = { isPending: false, error: null, data: agentMesh }
    render(<NodesCard />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('Served')
    expect(rows[0]?.textContent).toContain('4F2A9C1D7E')
    expect(screen.getByTestId('ca-strip').textContent).toContain('Cluster CA')
  })

  it('says in one sentence that the two certificates are separate', () => {
    render(<NodesCard />)
    expect(
      screen.getByText(/one it serves over HTTPS, one that proves its identity to the hub/),
    ).toBeTruthy()
  })
})
