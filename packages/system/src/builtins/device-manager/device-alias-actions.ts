/**
 * The template alias of a device (D1021): its generation at first registration,
 * the `setAlias` mutation, and the one-shot boot backfill for rows that predate
 * the column.
 *
 * The grammar and the slug live in `@camstack/types` (`device-alias.ts`); this
 * file owns the persistence and the cluster-wide uniqueness, always under the
 * meta write lock so two registrations cannot both claim `stufa`.
 */
import { randomUUID } from 'node:crypto'
import {
  checkDeviceAlias,
  deviceManagerCapability,
  EventCategory,
  generateDeviceAlias,
  type InferProvider,
} from '@camstack/types'
import type { ProviderContext } from './device-provider-context.js'
import type { DeviceRowStore } from './device-row-store.js'

type IDeviceManagerProvider = InferProvider<typeof deviceManagerCapability>

export const DEVICE_ALIAS_BACKFILL_MARKER_KEY = '_deviceAliasBackfillVersion'
export const DEVICE_ALIAS_BACKFILL_VERSION = 1

/**
 * The first free alias for `name`, against the persisted fleet. Caller holds the
 * meta write lock. `selfId` is the device the alias is for: finding itself is not
 * a collision.
 */
export async function freeAliasFor(
  rows: DeviceRowStore,
  name: string,
  selfId: number,
): Promise<string> {
  const refused = new Set<string>()
  for (;;) {
    const candidate = generateDeviceAlias(name, (alias) => refused.has(alias))
    const owner = await rows.findByAlias(candidate)
    if (owner === null || owner.meta.id === selfId) return candidate
    refused.add(candidate)
  }
}

export async function setAlias(
  pctx: ProviderContext,
  input: Parameters<IDeviceManagerProvider['setAlias']>[0],
): ReturnType<IDeviceManagerProvider['setAlias']> {
  const { deviceId, alias } = input
  const outcome = await pctx.metaStore.withMetaWriteLock(async () => {
    const persisted = await pctx.metaStore.resolvePersistedById(deviceId)
    if (!persisted) throw new Error(`[device-manager] setAlias: unknown device id=${deviceId}`)
    const grammar = checkDeviceAlias(alias, () => false)
    if (!grammar.ok) return grammar
    const owner = await pctx.metaStore.rows.findByAlias(alias)
    if (owner !== null && owner.meta.id !== deviceId) {
      return { ok: false as const, reason: 'taken' as const, takenBy: owner.meta.id }
    }
    if (persisted.meta.alias !== alias) {
      await pctx.metaStore.rows.patch(deviceId, { alias })
    }
    return grammar
  })
  if (!outcome.ok) {
    pctx.host.ctx.logger.info('setAlias refused', {
      tags: { deviceId },
      meta: { alias, reason: outcome.reason },
    })
    return outcome
  }
  pctx.host.ctx.eventBus.emit({
    id: randomUUID(),
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceMetaChanged,
    data: { deviceId, field: 'alias', value: outcome.alias },
  })
  return outcome
}

export interface AliasBackfillRow {
  readonly id: number
  readonly name: string
  readonly alias?: string
}

export interface AliasBackfillAssignment {
  readonly id: number
  readonly alias: string
}

/**
 * Who gets which alias. Rows are taken in id order, so the same fleet always
 * yields the same names; an alias a row already carries is kept and reserved.
 */
export function planAliasBackfill(
  rows: readonly AliasBackfillRow[],
): readonly AliasBackfillAssignment[] {
  const taken = new Set<string>()
  for (const row of rows) {
    if (row.alias !== undefined) taken.add(row.alias)
  }
  const out: AliasBackfillAssignment[] = []
  for (const row of rows.toSorted((a, b) => a.id - b.id)) {
    if (row.alias !== undefined) continue
    const alias = generateDeviceAlias(row.name, (candidate) => taken.has(candidate))
    taken.add(alias)
    out.push({ id: row.id, alias })
  }
  return out
}

/**
 * One-shot, under a version marker in the addon store (same posture as the
 * location and linked-devices backfills it sits beside): every device that has
 * no alias gets the slug of its current name, deduped. Registration also stamps
 * an alias-less row, so a device the boot missed heals the first time it registers.
 */
export async function runDeviceAliasBackfillAtBoot(pctx: ProviderContext): Promise<void> {
  const logger = pctx.host.ctx.logger
  const addonStore = await pctx.settings.readAddonStore()
  const markerRaw = addonStore[DEVICE_ALIAS_BACKFILL_MARKER_KEY]
  const completed = typeof markerRaw === 'number' ? markerRaw : 0
  if (completed >= DEVICE_ALIAS_BACKFILL_VERSION) return

  const stamped = await pctx.metaStore.withMetaWriteLock(async () => {
    const all = await pctx.metaStore.rows.listAll()
    // A row `allocateDeviceId` minted that never registered still carries its
    // placeholder name (the stableId): it is stamped at its first registration, from
    // the real name, not here.
    const plan = planAliasBackfill(
      all
        .filter((row) => row.registered)
        .map((row) => ({
          id: row.meta.id,
          name: row.meta.name,
          ...(row.meta.alias !== undefined ? { alias: row.meta.alias } : {}),
        })),
    )
    for (const assignment of plan) {
      await pctx.metaStore.rows.patch(assignment.id, { alias: assignment.alias })
      logger.debug('device alias backfilled (D1021)', {
        tags: { deviceId: assignment.id },
        meta: { alias: assignment.alias },
      })
    }
    return plan.length
  })
  await pctx.settings.writeAddonStore({
    ...addonStore,
    [DEVICE_ALIAS_BACKFILL_MARKER_KEY]: DEVICE_ALIAS_BACKFILL_VERSION,
  })
  logger.info('device aliases backfilled (D1021)', { meta: { devicesStamped: stamped } })
}
