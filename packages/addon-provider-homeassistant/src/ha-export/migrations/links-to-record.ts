/**
 * What the export carries to a Home Assistant instance moves into the instance's
 * `ha-export-links` record (planning#408 P4). Two migrations, both `block-owner`: the addon must
 * not serve a membership it cannot trust (an empty list unexposes every device on the next
 * reconcile), and after them nothing reads the old shape.
 *
 * The old shape, per broker: the `membership` setting (device ids), and the two flags, each kept
 * on the instance's integration (`exportTo`, `mediaRole`) or, for a broker the 2026-11-03
 * migration had not reached, in the dynamic addon keys `exportTo:<brokerId>` /
 * `mediaRole:<brokerId>`. The integration's value won over the key; so it does here.
 *
 *  1. `moveLinksToRecords` (procedure): one record per broker, id = broker id, written with
 *     `ifRev: 0` (an existing record is never overwritten), then read BACK and compared; a
 *     mismatch throws and nothing is deleted.
 *  2. `planDropMovedLinks` (plan): the addon keys are deleted only while every record holds what
 *     they carry; a missing or short record refuses, a read that fails leaves them in place. The
 *     `exportTo` / `mediaRole` values on the integrations are the provider's instance data and
 *     are not touched here; nothing in this addon reads them any more.
 */
import { type MigrationPlan, type MigrationProcedureResult, preconditionOf } from '@camstack/types'
import type { HaInstanceRow } from '../../ha-instance-settings.js'
import type { HaExportLinksBody } from '../link-records.js'
import { HA_MEDIA_ROLES, type HaMediaRole } from '../media-url.js'
import { ADDON_SETTINGS_TABLE, HA_EXPORT_ADDON_ID } from './drop-public-base-url.js'

export const MEMBERSHIP_KEY = 'membership'
const EXPORT_PREFIX = 'exportTo:'
const ROLE_PREFIX = 'mediaRole:'

export interface LinksMigrationPorts {
  /** The addon's stored settings as written. Throws when they cannot be read. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Every Home Assistant integration with its stored settings. Throws when unreadable. */
  listInstances(): Promise<readonly HaInstanceRow[]>
  warn(message: string): void
  /** Put the record of one broker with `ifRev: 0`; `exists` when one is already there. */
  putLinks(brokerId: string, body: HaExportLinksBody): Promise<'created' | 'exists'>
  /** Every `ha-export-links` record by broker id. Throws when unreadable. */
  readLinks(): Promise<ReadonlyMap<string, HaExportLinksBody>>
}

export type DropMovedLinksPorts = Pick<
  LinksMigrationPorts,
  'readStored' | 'listInstances' | 'warn' | 'readLinks'
>

/** What the old shape says about one broker. */
interface LegacyLinks {
  readonly brokerId: string
  readonly exportTo: boolean
  readonly mediaRole: HaMediaRole
  readonly devices: readonly string[]
}

const roleOf = (value: unknown): HaMediaRole | undefined =>
  HA_MEDIA_ROLES.find((role) => role === value)

function membershipOf(value: unknown): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [brokerId, devices] of Object.entries(value)) {
    if (!Array.isArray(devices)) continue
    out.set(
      brokerId,
      devices.filter((device): device is string => typeof device === 'string'),
    )
  }
  return out
}

function integrationByBroker(
  rows: readonly HaInstanceRow[],
  warn: (message: string) => void,
): ReadonlyMap<string, HaInstanceRow> {
  const out = new Map<string, HaInstanceRow>()
  for (const row of [...rows].sort((a, b) => a.integrationId.localeCompare(b.integrationId))) {
    if (row.brokerId === null) continue
    if (out.has(row.brokerId)) {
      warn(
        `homeassistant-export: integrations ${out.get(row.brokerId)?.integrationId} and ${row.integrationId} both link broker ${row.brokerId}; the first one answers`,
      )
      continue
    }
    out.set(row.brokerId, row)
  }
  return out
}

/** Every broker the old shape has something for, with the value the old reader would have used. */
function legacyLinks(
  stored: Readonly<Record<string, unknown>>,
  rows: readonly HaInstanceRow[],
  warn: (message: string) => void,
): readonly LegacyLinks[] {
  const membership = membershipOf(stored[MEMBERSHIP_KEY])
  // A stored integration always carries at least its `brokerId`: a row that reads as empty is a
  // row the hub could not answer, and its flags would be defaulted to off from nothing.
  const unreadable = rows.find((row) => Object.keys(row.settings).length === 0)
  if (unreadable !== undefined && membership.size > 0) {
    throw new Error(
      `the settings of integration ${unreadable.integrationId} read as empty; the export switch cannot be carried from an unreadable source, nothing was written`,
    )
  }
  const integrations = integrationByBroker(rows, warn)
  const brokers = new Set<string>(membership.keys())
  for (const key of Object.keys(stored)) {
    for (const prefix of [EXPORT_PREFIX, ROLE_PREFIX]) {
      if (key.startsWith(prefix) && key.length > prefix.length)
        brokers.add(key.slice(prefix.length))
    }
  }
  for (const [brokerId, row] of integrations) {
    if ('exportTo' in row.settings || 'mediaRole' in row.settings) brokers.add(brokerId)
  }
  return [...brokers].sort().map((brokerId) => {
    const own = integrations.get(brokerId)?.settings
    const ownExport = own?.['exportTo']
    const ownRole = own?.['mediaRole']
    return {
      brokerId,
      exportTo:
        typeof ownExport === 'boolean' ? ownExport : stored[`${EXPORT_PREFIX}${brokerId}`] === true,
      mediaRole:
        roleOf(ownRole !== undefined ? ownRole : stored[`${ROLE_PREFIX}${brokerId}`]) ?? 'internal',
      devices: membership.get(brokerId) ?? [],
    }
  })
}

/** The addon keys the old shape lives in. */
function legacyKeys(stored: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(stored).filter(
    (key) =>
      key === MEMBERSHIP_KEY ||
      (key.startsWith(EXPORT_PREFIX) && key.length > EXPORT_PREFIX.length) ||
      (key.startsWith(ROLE_PREFIX) && key.length > ROLE_PREFIX.length),
  )
}

const sameDevices = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((device, index) => device === b[index])

export async function moveLinksToRecords(
  ports: LinksMigrationPorts,
): Promise<MigrationProcedureResult> {
  const links = legacyLinks(await ports.readStored(), await ports.listInstances(), ports.warn)
  if (links.length === 0) return { outcome: 'already-done', summary: { moved: 0 } }
  const created: LegacyLinks[] = []
  for (const link of links) {
    const body: HaExportLinksBody = {
      name: link.brokerId,
      exportTo: link.exportTo,
      mediaRole: link.mediaRole,
      devices: link.devices,
    }
    if ((await ports.putLinks(link.brokerId, body)) === 'created') created.push(link)
  }
  if (created.length === 0) return { outcome: 'already-done', summary: { moved: 0 } }
  const held = await ports.readLinks()
  for (const link of created) {
    const row = held.get(link.brokerId)
    if (
      row === undefined ||
      row.exportTo !== link.exportTo ||
      row.mediaRole !== link.mediaRole ||
      !sameDevices(row.devices, link.devices)
    ) {
      throw new Error(
        `the export-links record of ${link.brokerId} does not match the legacy settings; nothing was cleared`,
      )
    }
  }
  return {
    outcome: 'done',
    summary: {
      moved: created.length,
      devices: created.reduce((sum, link) => sum + link.devices.length, 0),
    },
  }
}

const rowId = (key: string): string => `${HA_EXPORT_ADDON_ID}.${key}`

export async function planDropMovedLinks(ports: DropMovedLinksPorts): Promise<MigrationPlan> {
  const stored = await ports.readStored()
  const present = legacyKeys(stored)
  if (present.length === 0) return { edits: [] }
  const refuse = (reason: string): never => {
    ports.warn(`homeassistant-export: the legacy export keys are kept: ${reason}`)
    throw new Error(`the legacy export keys are not deleted: ${reason}`)
  }
  const links = legacyLinks(stored, await ports.listInstances(), ports.warn)
  const held = await ports.readLinks()
  for (const link of links) {
    const row = held.get(link.brokerId)
    if (row === undefined) return refuse(`no export-links record exists for ${link.brokerId}`)
    for (const device of link.devices) {
      if (!row.devices.includes(device)) {
        return refuse(`the record of ${link.brokerId} lacks the device ${device}`)
      }
    }
    if (row.exportTo !== link.exportTo || row.mediaRole !== link.mediaRole) {
      return refuse(`the record of ${link.brokerId} disagrees on the switch or the address role`)
    }
  }
  return {
    edits: [
      {
        op: 'deleteKeys',
        scope: ADDON_SETTINGS_TABLE,
        keys: present.map(rowId),
        precondition: preconditionOf(
          Object.fromEntries(
            present.map((key) => [
              rowId(key),
              { addonId: HA_EXPORT_ADDON_ID, key, value: stored[key] },
            ]),
          ),
        ),
      },
    ],
  }
}
