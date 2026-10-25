/**
 * "Connect a phone" renders each state from an ANSWERED query (D315):
 * pending is "reading", a failed read is a failure with its reason, and only
 * an answer without a phone-reachable address says there is none. The link
 * shown and copied carries the hub origin and nothing else.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionEndpoint } from '@camstack/types'
import i18n from '../../../i18n'

interface FakeQuery {
  readonly isPending: boolean
  readonly isError: boolean
  readonly error: Error | null
  readonly data: { readonly endpoints: readonly ConnectionEndpoint[] } | undefined
  readonly refetch: () => void
}

const refetch = vi.fn()
let query: FakeQuery
/** `getAddresses().roles.publicEndpoint.resolved`; undefined = not answered. */
let publicEndpoint: string | null | undefined
const inputs: unknown[] = []

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useLocalNetworkGetConnectionEndpoints: (input: unknown) => {
      inputs.push(input)
      return query
    },
    useLocalNetworkGetAddresses: () => ({
      data:
        publicEndpoint === undefined
          ? undefined
          : { roles: { publicEndpoint: { resolved: publicEndpoint } } },
    }),
  }
})

const { ConnectPhoneCard } = await import('../ConnectPhoneCard')

function answered(endpoints: readonly ConnectionEndpoint[]): FakeQuery {
  return { isPending: false, isError: false, error: null, data: { endpoints }, refetch }
}

const LAN: ConnectionEndpoint = {
  label: 'LAN — eth0',
  baseUrl: 'http://192.168.10.9:4080',
  kind: 'lan-ipv4',
  interfaceKind: 'lan',
  plausible: true,
  plausibleReason: '',
  priority: 0,
}
const MESH: ConnectionEndpoint = {
  label: 'Mesh (Tailscale)',
  baseUrl: 'https://hub.tail1234.ts.net:4443',
  kind: 'public',
  interfaceKind: 'vpn',
  plausible: true,
  plausibleReason: '',
  priority: 150,
}
const LOOPBACK: ConnectionEndpoint = {
  label: 'Loopback',
  baseUrl: 'https://127.0.0.1:4443',
  kind: 'loopback',
  interfaceKind: 'loopback',
  plausible: false,
  plausibleReason: '',
  priority: 1000,
}

beforeEach(async () => {
  refetch.mockReset()
  inputs.length = 0
  publicEndpoint = undefined
  await i18n.changeLanguage('en')
})

describe('ConnectPhoneCard', () => {
  it('asks the hub for its phone-facing palette without a port echo', () => {
    query = answered([MESH])
    render(<ConnectPhoneCard />)
    expect(inputs[0]).toEqual({ scheme: 'https' })
  })

  it('says it is reading while the query is pending — never "no address"', () => {
    query = { isPending: true, isError: false, error: null, data: undefined, refetch }
    render(<ConnectPhoneCard />)
    expect(screen.getByText(/Reading this hub's addresses/)).toBeTruthy()
    expect(screen.queryByText(/advertises no address/)).toBeNull()
  })

  it('reports a failed read with its reason and offers a retry', () => {
    query = {
      isPending: false,
      isError: true,
      error: new Error('FORBIDDEN'),
      data: undefined,
      refetch,
    }
    render(<ConnectPhoneCard />)
    expect(screen.getByText(/Could not read this hub's addresses: FORBIDDEN/)).toBeTruthy()
    expect(screen.queryByText(/advertises no address/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('says there is no address only when the answer holds none a phone can use', () => {
    query = answered([LOOPBACK])
    render(<ConnectPhoneCard />)
    expect(screen.getByText(/advertises no address a phone can reach/)).toBeTruthy()
  })

  it('defaults to the mesh over the LAN and lets the operator pick the LAN', () => {
    query = answered([LAN, MESH])
    render(<ConnectPhoneCard />)
    const meshLink =
      'https://camstack.zentik.app/connect?hub=https%3A%2F%2Fhub.tail1234.ts.net%3A4443'
    expect(screen.getByText(meshLink)).toBeTruthy()
    expect(screen.queryByText(/Plain HTTP address/)).toBeNull()

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'http://192.168.10.9:4080' },
    })
    expect(
      screen.getByText('https://camstack.zentik.app/connect?hub=http%3A%2F%2F192.168.10.9%3A4080'),
    ).toBeTruthy()
    expect(screen.getByText(/Plain HTTP address/)).toBeTruthy()
  })

  it('pre-selects the hub public endpoint over the ranking (D734)', () => {
    query = answered([LAN, MESH])
    publicEndpoint = 'http://192.168.10.9:4080'
    render(<ConnectPhoneCard />)
    expect(
      screen.getByText('https://camstack.zentik.app/connect?hub=http%3A%2F%2F192.168.10.9%3A4080'),
    ).toBeTruthy()
  })

  it('renders in Italian', async () => {
    await i18n.changeLanguage('it')
    query = answered([MESH])
    render(<ConnectPhoneCard />)
    expect(screen.getByText('Collega un telefono')).toBeTruthy()
  })
})
