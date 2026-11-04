/**
 * Export targets (#422): the `ha-export-links` record of each Home Assistant broker (id = broker
 * id) becomes an `ha-export-targets` record under a MINTED id (`hae_001`, ...) that names the
 * broker as its `connectionId`. Two migrations, both `block-owner`: the addon must not serve a
 * membership it cannot trust (an empty list unexposes every device on the next reconcile).
 *
 *  1. `moveLinksToTargets` (procedure, seq 6): per link row, in broker-id order, put a target
 *     with `ifRev: 0` carrying the name, the media role, the devices, the switch (`exportTo`) and
 *     the addon-level `reconcileIntervalSec` (default 300). A link whose broker already has a
 *     target is skipped (a rerun creates nothing). Every created target is read BACK and compared
 *     field by field, devices element-wise; a mismatch throws and nothing is deleted. A failed
 *     read of either kind throws before anything is written.
 *  2. `dropLinksAndCache` (procedure, seq 7): a link row is deleted only while its target holds
 *     the same devices, element-wise; a link whose target is missing or differs stays parked and
 *     is named. The `reconcileIntervalSec` and `knownBrokers` settings go once no link is parked.
 */
import { type MigrationProcedureResult } from '@camstack/types'
import {
  DEFAULT_RECONCILE_INTERVAL_SEC,
  type HaExportTargetBody,
  nextTargetId,
} from '../target-records.js'
import type { HaExportLinksBody } from './legacy-links-kind.js'

export const RECONCILE_INTERVAL_KEY = 'reconcileIntervalSec'
export const KNOWN_BROKERS_KEY = 'knownBrokers'

export interface TargetsFromLinksPorts {
  /** The addon's stored settings as written. Throws when they cannot be read. */
  readStored(): Promise<Readonly<Record<string, unknown>>>
  /** Every `ha-export-links` record by broker id. Throws when unreadable. */
  readLinks(): Promise<ReadonlyMap<string, HaExportLinksBody>>
  /** Every `ha-export-targets` record by target id. Throws when unreadable. */
  readTargets(): Promise<ReadonlyMap<string, HaExportTargetBody>>
  /** Put a target with `ifRev: 0`; `exists` when the id is already taken. */
  putTarget(id: string, body: HaExportTargetBody): Promise<'created' | 'exists'>
  warn(message: string): void
}

export interface DropLinksAndCachePorts {
  readStored: TargetsFromLinksPorts['readStored']
  readLinks: TargetsFromLinksPorts['readLinks']
  readTargets: TargetsFromLinksPorts['readTargets']
  warn: TargetsFromLinksPorts['warn']
  /** Delete the link rows of these broker ids. */
  deleteLinks(brokerIds: readonly string[]): Promise<void>
  /** Delete these keys of the addon's settings. */
  clearSettingKeys(keys: readonly string[]): Promise<void>
}

export const sameDevices = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((device, index) => device === b[index])

function intervalOf(stored: Readonly<Record<string, unknown>>): number {
  const value = stored[RECONCILE_INTERVAL_KEY]
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_RECONCILE_INTERVAL_SEC
}

function matches(target: HaExportTargetBody, expected: HaExportTargetBody): boolean {
  return (
    target.name === expected.name &&
    target.connectionId === expected.connectionId &&
    target.mediaRole === expected.mediaRole &&
    target.reconcileIntervalSec === expected.reconcileIntervalSec &&
    target.enabled === expected.enabled &&
    sameDevices(target.devices, expected.devices)
  )
}

export async function moveLinksToTargets(
  ports: TargetsFromLinksPorts,
): Promise<MigrationProcedureResult> {
  const links = await ports.readLinks()
  if (links.size === 0) return { outcome: 'already-done', summary: { moved: 0 } }
  const targets = await ports.readTargets()
  const stored = await ports.readStored()
  const reconcileIntervalSec = intervalOf(stored)
  const taken = new Set([...targets.values()].map((target) => target.connectionId))
  const ids = new Set(targets.keys())
  const created = new Map<string, HaExportTargetBody>()
  for (const brokerId of [...links.keys()].sort()) {
    if (taken.has(brokerId)) continue
    const link = links.get(brokerId)
    if (link === undefined) continue
    const body: HaExportTargetBody = {
      name: link.name,
      connectionId: brokerId,
      mediaRole: link.mediaRole,
      reconcileIntervalSec,
      devices: [...link.devices],
      enabled: link.exportTo,
    }
    const id = nextTargetId(ids)
    if ((await ports.putTarget(id, body)) === 'exists') {
      throw new Error(`the export target id ${id} is already taken; nothing was cleared`)
    }
    ids.add(id)
    created.set(id, body)
  }
  if (created.size === 0) return { outcome: 'already-done', summary: { moved: 0 } }
  const held = await ports.readTargets()
  for (const [id, expected] of created) {
    const row = held.get(id)
    if (row === undefined || !matches(row, expected)) {
      throw new Error(
        `the export target ${id} of connection ${expected.connectionId} does not match its link record; nothing was cleared`,
      )
    }
  }
  return {
    outcome: 'done',
    summary: {
      moved: created.size,
      devices: [...created.values()].reduce((sum, target) => sum + target.devices.length, 0),
    },
  }
}

export async function dropLinksAndCache(
  ports: DropLinksAndCachePorts,
): Promise<MigrationProcedureResult> {
  const links = await ports.readLinks()
  const stored = await ports.readStored()
  const targets = await ports.readTargets()
  const movable: string[] = []
  const parked: string[] = []
  for (const [brokerId, link] of links) {
    const target = [...targets.values()].find((candidate) => candidate.connectionId === brokerId)
    if (target !== undefined && sameDevices(target.devices, link.devices)) movable.push(brokerId)
    else parked.push(brokerId)
  }
  if (parked.length > 0) {
    ports.warn(
      `homeassistant-export: the link records of ${parked.join(', ')} are kept: no export target holds the same devices`,
    )
  }
  if (movable.length > 0) await ports.deleteLinks(movable)
  const keys =
    parked.length > 0
      ? []
      : [RECONCILE_INTERVAL_KEY, KNOWN_BROKERS_KEY].filter((key) => key in stored)
  if (keys.length > 0) await ports.clearSettingKeys(keys)
  if (movable.length === 0 && keys.length === 0) {
    return { outcome: 'already-done', summary: { parked: parked.length } }
  }
  return {
    outcome: 'done',
    summary: {
      deleted: movable.length,
      parked: parked.length,
      keys: keys.length,
    },
  }
}
