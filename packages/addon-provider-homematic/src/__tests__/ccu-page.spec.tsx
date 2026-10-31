/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import HomematicCcuPage from '../page.js'
import type { CcuTrpc } from '../ui/ccu-client.js'

type Handler = (input: Record<string, unknown>) => unknown

function fakeTrpc(handlers: Record<string, Handler>) {
  const calls: { action: string; input: Record<string, unknown> }[] = []
  const trpc: CcuTrpc = {
    addons: {
      custom: {
        mutate: async ({ action, input }) => {
          const asRecord: Record<string, unknown> =
            typeof input === 'object' && input !== null ? { ...input } : {}
          calls.push({ action, input: asRecord })
          const handler = handlers[action]
          if (handler === undefined) throw new Error(`unexpected action ${action}`)
          return handler(asRecord)
        },
      },
    },
  }
  return { trpc, calls }
}

const IFACE = {
  name: 'HmIP-RF',
  port: 2010,
  info: null,
  connected: true,
  dutyCycle: 12,
  firmware: '2.8.6',
  type: 'HmIP',
  gateways: [],
}
const OVERVIEW = {
  info: {
    version: '3.75.7',
    product: 'raspberrymatic',
    productFamily: 'openccu',
    platform: 'rpi4',
    serial: 'SER1',
    hostname: 'homematic',
  },
  infoError: null,
  interfaces: [IFACE],
  interfacesError: null,
}
const MESSAGE = {
  id: 'm1',
  name: 'Hall lamp',
  address: 'ABC',
  channel: 0,
  type: 'STICKY_UNREACH',
  timestamp: 1_700_000_000_000,
  acknowledgeable: true,
}

// Documented type boundary: the fake implements the one call the page makes (`addons.custom`).
function mountPage(trpc: CcuTrpc) {
  return render(
    <ConfirmDialogProvider>
      <HomematicCcuPage trpc={trpc as never} theme={{ isDark: true }} navigate={() => undefined} />
    </ConfirmDialogProvider>,
  )
}

afterEach(() => cleanup())

describe('HomematicCcuPage overview', () => {
  const base = {
    listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: true }],
    ccuOverview: () => OVERVIEW,
    listServiceMessages: () => ({ messages: [MESSAGE], error: null }),
  }

  it('shows the CCU, its interface health and the service messages', async () => {
    const { trpc } = fakeTrpc(base)
    mountPage(trpc)
    expect(await screen.findByText('3.75.7')).toBeTruthy()
    expect(screen.getByText('HmIP-RF')).toBeTruthy()
    expect(screen.getByText('12%')).toBeTruthy()
    expect(await screen.findByText('STICKY_UNREACH')).toBeTruthy()
  })

  it('says why the CCU details are missing instead of showing blanks', async () => {
    const { trpc } = fakeTrpc({
      ...base,
      ccuOverview: () => ({ ...OVERVIEW, info: null, infoError: 'needs WebUI credentials' }),
    })
    mountPage(trpc)
    expect(await screen.findByText('needs WebUI credentials')).toBeTruthy()
    expect(screen.getByText('HmIP-RF')).toBeTruthy()
  })

  it('renders a disconnected CCU as not connected, not as empty', async () => {
    const { trpc, calls } = fakeTrpc({
      ...base,
      listCcus: () => [{ integrationId: 'hm_1', name: 'Casa', connected: false }],
    })
    mountPage(trpc)
    expect(await screen.findByText('Casa is not connected')).toBeTruthy()
    expect(calls.some((c) => c.action === 'ccuOverview')).toBe(false)
  })

  it('does not acknowledge when the operator declines the dialog', async () => {
    const { trpc, calls } = fakeTrpc({ ...base, acknowledgeServiceMessage: () => ({ ok: true }) })
    mountPage(trpc)
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.some((c) => c.action === 'acknowledgeServiceMessage')).toBe(false)
  })

  it('acknowledges only after confirmation, sending confirmed: true', async () => {
    const ack = vi.fn().mockReturnValue({ ok: true })
    const { trpc, calls } = fakeTrpc({ ...base, acknowledgeServiceMessage: ack })
    mountPage(trpc)
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(ack).toHaveBeenCalled())
    expect(ack.mock.calls[0]?.[0]).toEqual({ integrationId: 'hm_1', id: 'm1', confirmed: true })
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'listServiceMessages').length).toBe(2),
    )
  })
})
