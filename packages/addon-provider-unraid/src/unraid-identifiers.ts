/**
 * What an Unraid server and its VMs declare as their identity (D1059).
 *
 * - The server: its SMBIOS uuid (`machine-uuid`), the MACs of its physical NICs,
 *   its flash GUID (`vendor-uid` `unraid:<guid>`, the USB key the license is
 *   bound to), its hostname and LAN IP (weak). The kinds of a read that FAILED
 *   are `unread` (D49): `system.info()` carries the uuid, MACs and hostname,
 *   `server.info()` the GUID and IP. An answer without a server, or without a
 *   network list, is unknown too, never "found absent".
 * - A VM: its libvirt domain uuid, which is the guest's SMBIOS uuid, so the
 *   guest's own integration can match it. A VM the poll could not see declares
 *   nothing.
 * - A container: nothing — no hardware identity of its own.
 */
import {
  type DeclareIdentifiersDeps,
  declareDeviceIdentifiers,
  type DeviceIdentifierKey,
  type RawDeviceIdentifiers,
} from '@camstack/types'
import type { UnraidServerIdentity, UnraidVmInfo } from './unraid-client-contract.js'
import { localIdOf } from './unraid-mapping.js'

export interface UnraidIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

/** The SMBIOS uuid unbranded boards ship ("filled by O.E.M."): shared by thousands of machines. */
const PLACEHOLDER_SMBIOS_UUIDS: ReadonlySet<string> = new Set([
  '03000200-0400-0500-0006-000700080009',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function machineUuid(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim().toLowerCase()
  return PLACEHOLDER_SMBIOS_UUIDS.has(value) ? null : value
}

export function unraidServerIdentifiers(
  identity: UnraidServerIdentity | undefined,
): UnraidIdentifierDeclaration | null {
  if (identity === undefined) return null
  const unread: DeviceIdentifierKey[] = [
    ...(identity.systemRead ? [] : (['machine-uuid', 'hostname'] as const)),
    ...(identity.systemRead && identity.macs !== null ? [] : (['mac'] as const)),
    ...(identity.serverRead ? [] : (['vendor-uid', 'ip'] as const)),
  ]
  return {
    identifiers: {
      machineUuid: machineUuid(identity.machineUuid),
      mac: identity.macs ?? [],
      hostname: identity.hostname,
      vendorUid: identity.flashGuid === null ? null : { vendor: 'unraid', id: identity.flashGuid },
      ip: identity.lanIp,
    },
    unread,
  }
}

export function unraidVmIdentifiers(vm: UnraidVmInfo | null): UnraidIdentifierDeclaration | null {
  if (vm === null) return null
  const uuid = localIdOf(vm.id).trim().toLowerCase()
  return {
    identifiers: { machineUuid: UUID.test(uuid) ? uuid : null },
    unread: [],
  }
}

/**
 * Sends a device's declaration when it changed since the last one that landed — the poll
 * re-derives it every tick, and an unchanged one need not cross the wire.
 */
export class UnraidIdentityDeclarer {
  #lastKey: string | null = null
  readonly #deps: DeclareIdentifiersDeps

  constructor(deps: DeclareIdentifiersDeps) {
    this.#deps = deps
  }

  async declare(declaration: UnraidIdentifierDeclaration | null): Promise<void> {
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.#lastKey) return
    this.#lastKey = key
    const result = await declareDeviceIdentifiers(this.#deps, declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.#lastKey = null
  }
}
