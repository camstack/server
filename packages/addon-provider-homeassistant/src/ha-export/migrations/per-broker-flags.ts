/**
 * Whether the export reaches a Home Assistant instance, and which hub address role its image
 * links use, are facts of THAT instance (D985): they live in the instance's integration settings
 * as `exportTo` and `mediaRole`, not in the addon store as one dynamic key per broker
 * (`exportTo:<brokerId>`, `mediaRole:<brokerId>`).
 *
 * Two migrations:
 *
 * 1. `per-broker-flags-to-integration` (procedure) copies each legacy key to the integration that
 *    links its broker. A flag the integration already has is never overwritten; a key whose
 *    broker has no integration any more (a deleted instance) is skipped, never recreated; two
 *    integrations linking one broker are an ambiguity and throw; a value that is not a boolean /
 *    a known role is skipped (the reader already treats it as off / `internal`).
 * 2. `drop-per-broker-flags` (plan) deletes a legacy key only after a read-back: the integration
 *    must show the same flag. A key the integration disagrees with (its own value was there
 *    first) or whose broker has no integration stays PARKED in place, never deleted.
 *
 * Both are idempotent.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import type { HaInstanceRow, HaInstanceSettingsPorts } from '../../ha-instance-settings.js'
import { HA_EXPORT_ADDON_ID, ADDON_SETTINGS_TABLE } from './drop-public-base-url.js'
import { HA_MEDIA_ROLES } from '../media-url.js'

export interface PerBrokerFlagsPorts extends HaInstanceSettingsPorts {
  /** The addon's stored settings as written, unparsed. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
}

type Flag = 'exportTo' | 'mediaRole'

interface LegacyFlag {
  readonly storeKey: string
  readonly brokerId: string
  readonly flag: Flag
  readonly value: unknown
}

const PREFIX: Readonly<Record<Flag, string>> = {
  exportTo: 'exportTo:',
  mediaRole: 'mediaRole:',
}

const validValue = (flag: Flag, value: unknown): boolean =>
  flag === 'exportTo'
    ? typeof value === 'boolean'
    : typeof value === 'string' && HA_MEDIA_ROLES.some((role) => role === value)

/** Every legacy key with a value the reader understands, per broker. */
function legacyFlags(stored: Readonly<Record<string, unknown>>): readonly LegacyFlag[] {
  const out: LegacyFlag[] = []
  for (const [storeKey, value] of Object.entries(stored)) {
    for (const flag of ['exportTo', 'mediaRole'] as const) {
      const prefix = PREFIX[flag]
      if (!storeKey.startsWith(prefix) || storeKey.length === prefix.length) continue
      if (validValue(flag, value)) {
        out.push({
          storeKey,
          brokerId: storeKey.slice(prefix.length),
          flag,
          value,
        })
      }
    }
  }
  return out
}

/** The one integration per broker; two integrations linking one broker are an ambiguity. */
function instanceByBroker(rows: readonly HaInstanceRow[]): ReadonlyMap<string, HaInstanceRow> {
  const out = new Map<string, HaInstanceRow>()
  for (const row of rows) {
    if (row.brokerId === null) continue
    const other = out.get(row.brokerId)
    if (other !== undefined) {
      throw new Error(
        `homeassistant-export: integrations ${other.integrationId} and ${row.integrationId} both link broker ${row.brokerId} — nothing copied`,
      )
    }
    out.set(row.brokerId, row)
  }
  return out
}

export async function copyFlagsToIntegrations(
  ports: PerBrokerFlagsPorts,
): Promise<MigrationProcedureResult> {
  const legacy = legacyFlags(await ports.readStored())
  if (legacy.length === 0)
    return { outcome: 'already-done', summary: { reason: 'no-legacy-flags' } }
  const byBroker = instanceByBroker(await ports.listInstances())
  const pending = new Map<string, Record<string, unknown>>()
  let kept = 0
  let skipped = 0
  for (const entry of legacy) {
    const instance = byBroker.get(entry.brokerId)
    if (instance === undefined) {
      skipped += 1
      continue
    }
    if (entry.flag in instance.settings) {
      kept += 1
      continue
    }
    pending.set(instance.integrationId, {
      ...pending.get(instance.integrationId),
      [entry.flag]: entry.value,
    })
  }
  let copied = 0
  let gone = 0
  for (const [integrationId, patch] of pending) {
    if (await ports.patchInstanceSettings(integrationId, patch)) copied += Object.keys(patch).length
    else gone += 1
  }
  return {
    outcome: copied === 0 ? 'already-done' : 'done',
    summary: { copied, kept, skipped, gone },
  }
}

export async function planDropPerBrokerFlags(ports: PerBrokerFlagsPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const legacy = legacyFlags(stored)
  if (legacy.length === 0) return { edits: [] }
  const byBroker = instanceByBroker(await ports.listInstances())
  const rowId = (key: string): string => `${HA_EXPORT_ADDON_ID}.${key}`
  const drop: LegacyFlag[] = []
  for (const entry of legacy) {
    const instance = byBroker.get(entry.brokerId)
    if (instance === undefined) continue
    if (!(entry.flag in instance.settings)) {
      throw new Error(
        `homeassistant-export: ${entry.storeKey} is not dropped, integration ${instance.integrationId} does not show ${entry.flag}`,
      )
    }
    if (instance.settings[entry.flag] === entry.value) drop.push(entry)
  }
  if (drop.length === 0) return { edits: [] }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: drop.map((entry) => rowId(entry.storeKey)),
        precondition: preconditionOf(
          Object.fromEntries(
            drop.map((entry) => [
              rowId(entry.storeKey),
              {
                addonId: HA_EXPORT_ADDON_ID,
                key: entry.storeKey,
                value: entry.value,
              },
            ]),
          ),
        ),
      },
    ],
  }
}
