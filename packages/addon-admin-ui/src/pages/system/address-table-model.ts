/**
 * address-table-model — what the Network page's Addresses table does when an
 * operator ticks a role on a row, as pure functions.
 *
 * Detected endpoints and custom addresses are flagged the same way. The hub
 * owns the rules (`local-network.setAddressRole`): a single-valued role
 * flagged on one row moves off every other row, so the table behaves like a
 * radio group per column without re-implementing that here. This module only
 * decides WHICH call a click makes, and when the operator must first accept a
 * plain-http public endpoint.
 */
import type { HubAddressBook, HubAddressRole, HubAddressRow } from '@camstack/types'
import { PUBLIC_ENDPOINT_HTTP_REASON } from '@camstack/types'
import i18n from '../../i18n/index'

export interface RoleColumn {
  readonly role: HubAddressRole
  readonly title: string
  /** At most one address carries it (a radio column). */
  readonly single: boolean
  readonly help: string
}

export const ROLE_COLUMNS: readonly RoleColumn[] = [
  {
    role: 'appConnections',
    get title() {
      return i18n.t('helpers.addressTableModel.appConnectionsTitle')
    },
    single: false,
    get help() {
      return i18n.t('helpers.addressTableModel.appConnectionsHelp')
    },
  },
  {
    role: 'notificationTaps',
    get title() {
      return i18n.t('helpers.addressTableModel.notificationTapsTitle')
    },
    single: true,
    get help() {
      return i18n.t('helpers.addressTableModel.notificationTapsHelp')
    },
  },
  {
    role: 'publicEndpoint',
    get title() {
      return i18n.t('helpers.addressTableModel.publicEndpointTitle')
    },
    single: true,
    get help() {
      return i18n.t('helpers.addressTableModel.publicEndpointHelp')
    },
  },
  {
    role: 'internal',
    get title() {
      return i18n.t('helpers.addressTableModel.internalTitle')
    },
    single: true,
    get help() {
      return i18n.t('helpers.addressTableModel.internalHelp')
    },
  },
]

/** The closing line of the "What are roles?" explanation. */
export const ROLES_CUSTOM_ADDRESS_HELP =
  'A role with nothing ticked is automatic. Add a custom address when the hub is reached at an address it cannot see itself (NAT, reverse proxy, VPN, Docker bridge).'

export interface SetAddressRoleInput {
  readonly role: HubAddressRole
  readonly baseUrl: string | null
  readonly enabled: boolean
  readonly acceptInsecureHttp?: boolean
}

export type RoleToggle =
  | { readonly kind: 'none' }
  | { readonly kind: 'set'; readonly input: SetAddressRoleInput }
  | { readonly kind: 'confirm-http'; readonly input: SetAddressRoleInput; readonly reason: string }

/** The box is ticked when the row serves the role now — flagged or automatic. */
export function isRoleChecked(row: HubAddressRow, role: HubAddressRole): boolean {
  return row.inUse.includes(role)
}

/**
 * The call a click on `role` of `row` makes.
 *
 * - Not eligible (loopback, the app link outside Notification taps) → nothing.
 * - The app link IS the automatic notification-taps answer: ticking it returns
 *   the role to automatic.
 * - A flagged row unticked → the flag goes (single role: back to automatic).
 * - A row serving a single role AUTOMATICALLY, clicked → pin it (flag it), so
 *   it stops moving with detection.
 * - An unticked row → flag it; a plain-http address for Public endpoint first needs
 *   the operator to accept http.
 */
export function roleToggle(row: HubAddressRow, role: HubAddressRole): RoleToggle {
  if (!row.eligible.includes(role)) return { kind: 'none' }
  if (row.kind === 'app-link') {
    return isRoleChecked(row, role)
      ? { kind: 'none' }
      : { kind: 'set', input: { role, baseUrl: null, enabled: true } }
  }
  const flagged = row.flags.includes(role)
  if (flagged) return { kind: 'set', input: { role, baseUrl: row.baseUrl, enabled: false } }
  if (role === 'appConnections' && isRoleChecked(row, role)) {
    return { kind: 'set', input: { role, baseUrl: row.baseUrl, enabled: false } }
  }
  const input: SetAddressRoleInput = { role, baseUrl: row.baseUrl, enabled: true }
  if (role === 'publicEndpoint' && row.baseUrl.startsWith('http:')) {
    return { kind: 'confirm-http', input, reason: PUBLIC_ENDPOINT_HTTP_REASON }
  }
  return { kind: 'set', input }
}

export interface RoleSummary {
  readonly role: HubAddressRole
  readonly title: string
  /** What is in use, as display text. */
  readonly inUse: string
  readonly automatic: boolean
}

/** Per role: the address in use and whether it is automatic. */
export function summarizeRoles(book: HubAddressBook): readonly RoleSummary[] {
  return ROLE_COLUMNS.map(({ role, title }) => {
    if (role === 'appConnections') {
      const v = book.roles.appConnections
      return {
        role,
        title,
        inUse: v.resolved.length === 0 ? 'nothing reachable' : v.resolved.join(', '),
        automatic: v.source !== 'flagged',
      }
    }
    const r = book.roles[role]
    const text =
      r.resolved === null
        ? 'nothing reachable'
        : role === 'notificationTaps' && r.source === 'auto'
          ? 'CamStack app link'
          : r.resolved
    return { role, title, inUse: text, automatic: r.source !== 'flagged' }
  })
}
