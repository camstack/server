/**
 * The Network page's Addresses table: detected and custom rows together, role
 * ticks routed through the one `setAddressRole`, a custom address added only
 * when it validates, and a plain-http sign-in held until the operator accepts.
 */
import type { HubAddressBook, HubAddressRow } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AddressesCard } from '../AddressesCard'

function row(over: Partial<HubAddressRow> & Pick<HubAddressRow, 'baseUrl'>): HubAddressRow {
  const base: HubAddressRow = {
    label: 'LAN — eth0',
    baseUrl: over.baseUrl,
    kind: 'lan-ipv4',
    interfaceKind: 'lan',
    plausible: true,
    plausibleReason: '',
    priority: 0,
    detected: true,
    custom: false,
    flags: [],
    inUse: [],
    eligible: ['appConnections', 'notificationTaps', 'internal', 'publicEndpoint'],
  }
  return { ...base, ...over }
}

const LAN = 'http://192.0.2.10:4480'
const LAN_HTTPS = 'https://192.0.2.10:4443'
const CUSTOM = 'https://cams.example.org'

const book: HubAddressBook = {
  rows: [
    row({ baseUrl: LAN, inUse: ['appConnections', 'internal'] }),
    row({ baseUrl: LAN_HTTPS, label: 'LAN — eth0 (HTTPS)', inUse: ['appConnections'] }),
    row({
      baseUrl: CUSTOM,
      label: 'Proxy',
      kind: 'custom',
      interfaceKind: 'other',
      detected: false,
      custom: true,
      flags: ['publicEndpoint'],
      inUse: ['publicEndpoint'],
    }),
  ],
  roles: {
    appConnections: { flagged: [], resolved: [LAN, LAN_HTTPS], source: 'auto' },
    notificationTaps: { flagged: null, resolved: 'https://camstack.zentik.app', source: 'auto' },
    internal: { flagged: null, resolved: LAN, source: 'auto' },
    publicEndpoint: { flagged: CUSTOM, resolved: CUSTOM, source: 'flagged' },
  },
  appLinkHub: null,
}

function renderCard() {
  const onSetRole = vi.fn()
  const onAdd = vi.fn()
  const onRemove = vi.fn()
  render(
    <AddressesCard
      book={book}
      loading={false}
      saving={false}
      error={null}
      onSetRole={onSetRole}
      onAdd={onAdd}
      onRemove={onRemove}
    />,
  )
  return { onSetRole, onAdd, onRemove }
}

describe('AddressesCard', () => {
  it('says per role what is in use and whether it is automatic', () => {
    renderCard()
    expect(screen.getByTestId('address-role-internal').textContent).toContain(LAN)
    expect(screen.getByTestId('address-role-internal').textContent).toContain('(automatic)')
    expect(screen.getByTestId('address-role-publicEndpoint').textContent).toContain('(set by you)')
  })

  it('explains every role, collapsed by default, and when to add a custom address', () => {
    renderCard()
    const help = screen.getByTestId('address-roles-help')
    expect(help.tagName).toBe('DETAILS')
    expect(help.hasAttribute('open')).toBe(false)
    expect(help.querySelector('summary')?.textContent).toBe('What are roles?')
    const text = help.textContent ?? ''
    expect(text).toContain('Addresses the CamStack apps try when connecting')
    expect(text).toContain('Only where tapping a notification opens')
    expect(text).toContain('download addons, models and media')
    expect(text).toContain('buttons, attachments and admin links in notifications')
    expect(text).toContain('Changing it invalidates registered passkeys.')
    expect(text).toContain('A role with nothing ticked is automatic.')
    expect(text).toContain('NAT, reverse proxy, VPN, Docker bridge')
    expect(text).not.toMatch(/\bD\d{3,}\b/)
  })

  it('the https counterpart of a LAN address is its own row, ticked, and can be turned off', () => {
    const { onSetRole } = renderCard()
    expect(screen.getByText('LAN — eth0 (HTTPS)')).toBeTruthy()
    const box = screen.getByLabelText(`App connections: ${LAN_HTTPS}`)
    expect(box.getAttribute('aria-checked') ?? (box as HTMLInputElement).checked.toString()).toBe(
      'true',
    )
    fireEvent.click(box)
    expect(onSetRole).toHaveBeenLastCalledWith({
      role: 'appConnections',
      baseUrl: LAN_HTTPS,
      enabled: false,
    })
  })

  it('explains the https rows in the app-connections help', () => {
    renderCard()
    expect(screen.getByTestId('address-roles-help').textContent).toContain(
      'Each LAN address also has an HTTPS row',
    )
  })

  it('a custom row is flagged exactly like a detected one', () => {
    const { onSetRole } = renderCard()
    fireEvent.click(screen.getByLabelText(`Internal: ${CUSTOM}`))
    expect(onSetRole).toHaveBeenLastCalledWith({ role: 'internal', baseUrl: CUSTOM, enabled: true })
    fireEvent.click(screen.getByLabelText(`Public endpoint: ${CUSTOM}`))
    expect(onSetRole).toHaveBeenLastCalledWith({
      role: 'publicEndpoint',
      baseUrl: CUSTOM,
      enabled: false,
    })
  })

  it('holds a plain-http public endpoint until the operator accepts http', () => {
    const { onSetRole } = renderCard()
    fireEvent.click(screen.getByLabelText(`Public endpoint: ${LAN}`))
    expect(onSetRole).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Use http anyway'))
    expect(onSetRole).toHaveBeenCalledWith({
      role: 'publicEndpoint',
      baseUrl: LAN,
      enabled: true,
      acceptInsecureHttp: true,
    })
  })

  it('adds a valid custom address, refuses loopback, and removes a custom row', () => {
    const { onAdd, onRemove } = renderCard()
    fireEvent.change(screen.getByLabelText('Custom address'), {
      target: { value: 'https://127.0.0.1:4443' },
    })
    fireEvent.click(screen.getByText('Add custom address'))
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.getByText(/loopback/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Custom address'), {
      target: { value: 'https://10.8.0.1:4443/' },
    })
    fireEvent.change(screen.getByLabelText('Custom address label'), { target: { value: 'VPN' } })
    fireEvent.click(screen.getByText('Add custom address'))
    expect(onAdd).toHaveBeenCalledWith('https://10.8.0.1:4443', 'VPN')
    fireEvent.click(screen.getByLabelText(`Remove ${CUSTOM}`))
    expect(onRemove).toHaveBeenCalledWith(CUSTOM)
  })
})
