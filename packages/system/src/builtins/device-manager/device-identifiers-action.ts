/**
 * `device-manager.setIdentifiers` — the ONE writer of a device's provider-declared
 * identifiers (D1059).
 *
 * Who may write: the provider that OWNS the device, and nobody else. Ownership is
 * the caller stamp the transport sets (`callerAddonId`, never in an input schema,
 * so a session cannot supply it — `CALLER_STAMPED_CAPABILITIES` lists
 * `device-manager`) compared with the row's `addonId`. An operator session carries
 * no stamp and is refused; so is another addon. The operator reads identifiers, it
 * never edits them: the free-form, editable blob is `metadata`.
 *
 * The stored value is `mergeIdentifiers(stored, declared, unread)`: each kind the
 * declaration carries replaces the stored one, each kind it lacks is removed,
 * except the kinds in `unread` (the provider's read FAILED), which keep what was
 * stored — a failed read never erases a fact (D49). An entry whose value and
 * origin are unchanged keeps its stored `readAt` (when that value was first read),
 * so a provider re-declaring the same values on every boot writes nothing and
 * emits nothing. `null` clears every kind not in `unread`.
 */

import { randomUUID } from 'node:crypto'
import {
  type DeviceIdentifierKey,
  type DeviceIdentifiers,
  DeviceIdentifiersSchema,
  EventCategory,
  isEmptyIdentifiers,
  mergeIdentifiers,
  sameIdentifiers,
  type IDeviceManagerProvider,
} from '@camstack/types'
import type { ProviderContext } from './device-provider-context.js'

/** Why a `setIdentifiers` call was refused. */
export type SetIdentifiersRefusal = 'unknown-device' | 'not-owner' | 'invalid'

export class SetIdentifiersRefusedError extends Error {
  constructor(
    readonly reason: SetIdentifiersRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'SetIdentifiersRefusedError'
  }
}

/** The caller the transport stamped; `null` when the call carries none. */
function stampedCaller(input: unknown): string | null {
  const raw: unknown = Reflect.get(Object(input), 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** The two declared-identity columns: the device's own, and its link's far end (D1063). */
export type DeclaredIdentityColumn = 'identifiers' | 'attachedIdentifiers'

const METHOD_OF: Readonly<Record<DeclaredIdentityColumn, string>> = {
  identifiers: 'setIdentifiers',
  attachedIdentifiers: 'setAttachedIdentifiers',
}

export async function setIdentifiers(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setIdentifiers']>[0],
): ReturnType<IDeviceManagerProvider['setIdentifiers']> {
  return writeDeclaredIdentity(pctx, input, 'identifiers')
}

/**
 * `device-manager.setAttachedIdentifiers` (D1063): the identity of the device at
 * the far end of this device's physical link. Same owner check, normalisation
 * and merge as {@link setIdentifiers}, its own column.
 */
export async function setAttachedIdentifiers(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setAttachedIdentifiers']>[0],
): ReturnType<IDeviceManagerProvider['setAttachedIdentifiers']> {
  return writeDeclaredIdentity(pctx, input, 'attachedIdentifiers')
}

/** The unread keys the merged declaration still holds, sorted: kept, not seen now. */
function retainedKeys(
  merged: DeviceIdentifiers | null,
  unread: readonly DeviceIdentifierKey[],
): readonly DeviceIdentifierKey[] {
  if (merged === null) return []
  return [...new Set(unread)].filter((key) => merged[key] !== undefined).sort()
}

async function writeDeclaredIdentity(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setIdentifiers']>[0],
  column: DeclaredIdentityColumn,
): Promise<void> {
  const method = METHOD_OF[column]
  const { deviceId } = input
  const logger = pctx.host.ctx.logger
  const caller = stampedCaller(input)
  const parsed = DeviceIdentifiersSchema.nullable().safeParse(input.identifiers)
  if (!parsed.success) {
    logger.warn(`${method} refused — the declaration is not in its normalised form`, {
      tags: { deviceId },
      meta: { caller, issues: parsed.error.issues.map((i) => i.path.join('.')) },
    })
    throw new SetIdentifiersRefusedError(
      'invalid',
      `[device-manager] ${method}: device ${deviceId} — declaration not normalised (use normaliseIdentifiers)`,
    )
  }
  const next = parsed.data === null || isEmptyIdentifiers(parsed.data) ? null : parsed.data

  const outcome = await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) return { kind: 'unknown-device' as const }
    if (caller === null || caller !== persisted.addonId) {
      return { kind: 'not-owner' as const, owner: persisted.addonId }
    }
    const stored = persisted.meta[column] ?? null
    const merged = mergeIdentifiers(stored, next, input.unread ?? [])
    if (column === 'identifiers') {
      if (sameIdentifiers(stored, merged)) return { kind: 'unchanged' as const }
      await pctx.metaStore.rows.patch(deviceId, { identifiers: merged })
      return { kind: 'written' as const, value: merged }
    }
    // An attached key kept because it was unread is RETAINED, not seen now (D1063).
    const retained = retainedKeys(merged, input.unread ?? [])
    const storedRetained = persisted.meta.attachedRetained ?? []
    const sameRetained = retained.join(',') === storedRetained.join(',')
    if (sameIdentifiers(stored, merged) && sameRetained) return { kind: 'unchanged' as const }
    await pctx.metaStore.rows.patch(deviceId, {
      attachedIdentifiers: merged,
      attachedRetained: retained.length === 0 ? null : retained,
    })
    return { kind: 'written' as const, value: merged }
  })

  if (outcome.kind === 'unknown-device') {
    throw new SetIdentifiersRefusedError(
      'unknown-device',
      `[device-manager] ${method}: unknown device id=${deviceId}`,
    )
  }
  if (outcome.kind === 'not-owner') {
    logger.warn(`${method} refused — only the owning provider declares identifiers`, {
      tags: { deviceId },
      meta: { caller, owner: outcome.owner },
    })
    throw new SetIdentifiersRefusedError(
      'not-owner',
      `[device-manager] ${method}: device ${deviceId} belongs to ${outcome.owner}; caller ${caller ?? '(unstamped)'} may not declare its identifiers`,
    )
  }
  if (outcome.kind === 'unchanged') return

  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: column, value: outcome.value },
  })
}
