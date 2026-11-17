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
 * The value REPLACES the whole declaration (the provider states everything it
 * knows each time); `null` clears it. A write equal to what is stored changes
 * nothing and emits nothing — providers declare on every boot.
 */

import { randomUUID } from 'node:crypto'
import {
  DeviceIdentifiersSchema,
  EventCategory,
  isEmptyIdentifiers,
  type DeviceIdentifiers,
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

/** Stable comparison of two declarations (key order of a JSON column is not guaranteed). */
function sameIdentifiers(a: DeviceIdentifiers | undefined, b: DeviceIdentifiers | null): boolean {
  const canonical = (v: DeviceIdentifiers | null | undefined): string =>
    v === null || v === undefined || isEmptyIdentifiers(v)
      ? ''
      : JSON.stringify(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
  return canonical(a) === canonical(b)
}

export async function setIdentifiers(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setIdentifiers']>[0],
): ReturnType<IDeviceManagerProvider['setIdentifiers']> {
  const { deviceId } = input
  const logger = pctx.host.ctx.logger
  const caller = stampedCaller(input)
  const parsed = DeviceIdentifiersSchema.nullable().safeParse(input.identifiers)
  if (!parsed.success) {
    logger.warn('setIdentifiers refused — the declaration is not in its normalised form', {
      tags: { deviceId },
      meta: { caller, issues: parsed.error.issues.map((i) => i.path.join('.')) },
    })
    throw new SetIdentifiersRefusedError(
      'invalid',
      `[device-manager] setIdentifiers: device ${deviceId} — declaration not normalised (use normaliseIdentifiers)`,
    )
  }
  const next = parsed.data === null || isEmptyIdentifiers(parsed.data) ? null : parsed.data

  const outcome = await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) return { kind: 'unknown-device' as const }
    if (caller === null || caller !== persisted.addonId) {
      return { kind: 'not-owner' as const, owner: persisted.addonId }
    }
    if (sameIdentifiers(persisted.meta.identifiers, next)) return { kind: 'unchanged' as const }
    await pctx.metaStore.rows.patch(deviceId, { identifiers: next })
    return { kind: 'written' as const }
  })

  if (outcome.kind === 'unknown-device') {
    throw new SetIdentifiersRefusedError(
      'unknown-device',
      `[device-manager] setIdentifiers: unknown device id=${deviceId}`,
    )
  }
  if (outcome.kind === 'not-owner') {
    logger.warn('setIdentifiers refused — only the owning provider declares identifiers', {
      tags: { deviceId },
      meta: { caller, owner: outcome.owner },
    })
    throw new SetIdentifiersRefusedError(
      'not-owner',
      `[device-manager] setIdentifiers: device ${deviceId} belongs to ${outcome.owner}; caller ${caller ?? '(unstamped)'} may not declare its identifiers`,
    )
  }
  if (outcome.kind === 'unchanged') return

  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'identifiers', value: next },
  })
}
