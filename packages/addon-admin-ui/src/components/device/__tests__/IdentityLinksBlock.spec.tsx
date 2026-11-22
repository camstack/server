/**
 * The device's identity links (D1063) on its Hardware tab.
 *
 *  - An unanswered read is never "none" (D315): pending and not-loaded each
 *    say what they are; only an answered empty list says none.
 *  - Confirm / Dismiss reach the device-manager decision with the link id; a
 *    refused decision is shown, never swallowed.
 *  - The relation reads from this device's side (the camera is "Powered by"
 *    the port), and a dismissed link is not listed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { IdentityLink, IdentityLinkDecision } from '@camstack/types'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const confirmLink = vi.fn<(input: { linkId: string }) => Promise<IdentityLinkDecision>>()
const dismissLink = vi.fn<(input: { linkId: string }) => Promise<IdentityLinkDecision>>()
const relinkLink = vi.fn<(input: { linkId: string }) => Promise<IdentityLinkDecision>>()
const unlinkLink = vi.fn<(input: { linkId: string }) => Promise<IdentityLinkDecision>>()
let linksQuery: { data: unknown; error: unknown } = {
  data: undefined,
  error: null,
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceManagerListIdentityLinks: () => linksQuery,
    useDeviceManagerGetDevice: (input: { deviceId: number }) => ({
      data: { name: input.deviceId === 10 ? 'Port 7' : 'Gate relay' },
    }),
    useDeviceManagerConfirmIdentityLink: () => ({
      mutateAsync: confirmLink,
      isPending: false,
    }),
    useDeviceManagerDismissIdentityLink: () => ({
      mutateAsync: dismissLink,
      isPending: false,
    }),
    useDeviceManagerRelinkIdentity: () => ({
      mutateAsync: relinkLink,
      isPending: false,
    }),
    useDeviceManagerUnlinkIdentity: () => ({
      mutateAsync: unlinkLink,
      isPending: false,
    }),
  }
})

import { IdentityLinksBlock } from '../overview-adapters/IdentityLinksBlock'

const PORT = { addonId: 'provider-unifi', stableId: 'port-7', deviceId: 10 }
const CAMERA = { addonId: 'provider-acme', stableId: 'cam-1', deviceId: 20 }
const TWIN = { addonId: 'provider-other', stableId: 'twin', deviceId: 30 }

function link(over: Partial<IdentityLink> = {}): IdentityLink {
  return {
    id: 'poe-power:port|cam',
    kind: 'poe-power',
    a: PORT,
    b: CAMERA,
    state: 'linked',
    origin: 'auto',
    evidence: [{ key: 'mac', value: 'aa:bb:cc:00:11:22' }],
    createdAt: 1,
    ...over,
  }
}

function renderBlock(deviceId = CAMERA.deviceId): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IdentityLinksBlock deviceId={deviceId} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  confirmLink.mockReset()
  dismissLink.mockReset()
  unlinkLink.mockReset()
  relinkLink.mockReset()
  linksQuery = { data: undefined, error: null }
})

afterEach(() => cleanup())

describe('IdentityLinksBlock', () => {
  it('a pending read draws a placeholder, never "none" (D315)', () => {
    renderBlock()
    expect(screen.getByTestId('identity-links-pending')).toBeTruthy()
    expect(screen.queryByText('No linked devices.')).toBeNull()
  })

  it('a store not read yet says so, never "none"', () => {
    linksQuery = {
      data: { status: 'not-loaded', reason: 'boot' },
      error: null,
    }
    renderBlock()
    expect(screen.getByText('Linked devices are not read yet.')).toBeTruthy()
    expect(screen.queryByText('No linked devices.')).toBeNull()
  })

  it('only an answered empty list says none; a dismissed link is not listed', () => {
    linksQuery = {
      data: {
        status: 'answered',
        links: [link({ state: 'dismissed', origin: 'operator' })],
      },
      error: null,
    }
    renderBlock()
    expect(screen.getByText('No linked devices.')).toBeTruthy()
  })

  it('the camera reads the port as "Powered by", the port reads the camera as "Powers"', () => {
    linksQuery = { data: { status: 'answered', links: [link()] }, error: null }
    renderBlock(CAMERA.deviceId)
    expect(screen.getByText('Powered by')).toBeTruthy()
    expect(screen.getByText('Port 7')).toBeTruthy()
    cleanup()
    renderBlock(PORT.deviceId)
    expect(screen.getByText('Powers')).toBeTruthy()
  })

  it('Confirm on a proposal calls confirmIdentityLink with the link id', async () => {
    const proposal = link({
      id: 'same-device:cam|twin',
      kind: 'same-device',
      a: CAMERA,
      b: TWIN,
      state: 'proposed',
    })
    linksQuery = {
      data: { status: 'answered', links: [proposal] },
      error: null,
    }
    confirmLink.mockResolvedValue({
      ok: true,
      link: { ...proposal, state: 'linked' },
    })
    renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(confirmLink).toHaveBeenCalledWith({
      linkId: 'same-device:cam|twin',
    })
    expect(dismissLink).not.toHaveBeenCalled()
  })

  it('a refused decision is shown, never swallowed', async () => {
    const proposal = link({ state: 'proposed' })
    linksQuery = {
      data: { status: 'answered', links: [proposal] },
      error: null,
    }
    dismissLink.mockResolvedValue({
      ok: false,
      reason: 'wrong-state',
      message: 'identity link is linked, not proposed',
    })
    renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText('identity link is linked, not proposed')).toBeTruthy()
  })

  it('a dismissed link offers Relink, which calls relinkIdentity with the link id', () => {
    const dismissed = link({ state: 'dismissed', origin: 'operator' })
    linksQuery = { data: { status: 'answered', links: [dismissed] }, error: null }
    relinkLink.mockResolvedValue({ ok: true, link: { ...dismissed, state: 'linked' } })
    renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Relink' }))
    expect(relinkLink).toHaveBeenCalledWith({ linkId: dismissed.id })
  })
})
