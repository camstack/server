/**
 * An export target (#422): one `ha-export-targets` record per place the export reaches. It names
 * the Home Assistant connection it pushes to (`connectionId`, a broker id), which hub address
 * role its image links use, how often it re-announces, and the devices exported to it.
 *
 * The record is the integration instance itself (`integration-instances`, role `services`): the
 * operator creates, edits, switches and deletes targets from the Connectivity page, and the ids
 * are minted here (`hae_001`, ...). Several targets may reference one connection.
 *
 * This addon is the only writer of `devices`; the instance door writes the rest. Both go through
 * `patch` (a merge), so neither overwrites the other, and the in-memory copy here is the
 * synchronous read the event path needs, reloaded after every change.
 */
import { type DefinedRecordKind, defineEntryKind, type RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import { HA_MEDIA_ROLES, type HaMediaRole } from './media-url.js'
import type { ExportMembership } from './membership.js'

export const HA_EXPORT_TARGETS_KIND_NAME = 'ha-export-targets'
export const HA_TARGET_KIND = 'ha-target'
export const TARGET_ID_PREFIX = 'hae_'
export const DEFAULT_RECONCILE_INTERVAL_SEC = 300
/** The shortest cadence a target may ask for; the form says so. */
export const MIN_RECONCILE_INTERVAL_SEC = 30

export type HaExportTargetBody = {
  readonly name: string
  /** The Home Assistant connection (broker id) this target pushes to; empty until chosen. */
  readonly connectionId: string
  readonly mediaRole: HaMediaRole
  readonly reconcileIntervalSec: number
  readonly devices: readonly string[]
  /** The target's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const HaExportTargetBodySchema: z.ZodType<HaExportTargetBody> = z.object({
  name: z.string().min(1),
  connectionId: z.string(),
  mediaRole: z.enum(HA_MEDIA_ROLES),
  reconcileIntervalSec: z.number(),
  devices: z.array(z.string()),
  enabled: z.boolean().optional(),
})

export const haExportTargetsKind: DefinedRecordKind<z.ZodType<HaExportTargetBody>> =
  defineEntryKind(HA_EXPORT_TARGETS_KIND_NAME, {
    title: 'Home Assistant export targets',
    nameField: 'name',
    schema: HaExportTargetBodySchema,
    writeTrigger:
      'an operator adds, edits, switches or deletes an export target, or exports a device to it',
  })

/** What a target starts as: on, public endpoint, five-minute cadence, no device, no connection yet. */
export function newTargetBody(name: string): HaExportTargetBody {
  return {
    name,
    connectionId: '',
    mediaRole: 'publicEndpoint',
    reconcileIntervalSec: DEFAULT_RECONCILE_INTERVAL_SEC,
    devices: [],
    enabled: true,
  }
}

/** The id after the highest `hae_NNN` among `existing`. */
export function nextTargetId(existing: Iterable<string>): string {
  let highest = 0
  for (const id of existing) {
    if (!id.startsWith(TARGET_ID_PREFIX)) continue
    const n = Number(id.slice(TARGET_ID_PREFIX.length))
    if (Number.isInteger(n) && n > highest) highest = n
  }
  return `${TARGET_ID_PREFIX}${String(highest + 1).padStart(3, '0')}`
}

/** Every record of the kind, once; a failed read throws (the caller must not serve "nothing"). */
export async function readAllTargets(
  handle: RecordKindHandle<HaExportTargetBody>,
): Promise<ReadonlyMap<string, HaExportTargetBody>> {
  const rows = new Map<string, HaExportTargetBody>()
  let cursor: string | undefined
  do {
    const page = await handle.query({
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const row of page.records) rows.set(row.id, row.data)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return rows
}

function membershipOf(rows: ReadonlyMap<string, HaExportTargetBody>): ExportMembership {
  const out: Record<string, readonly string[]> = {}
  for (const [id, row] of rows) if (row.devices.length > 0) out[id] = row.devices
  return out
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * The in-memory copy of the target records. `membership()` keeps its identity until a device
 * list changes.
 */
export class ExportTargets {
  private rows: ReadonlyMap<string, HaExportTargetBody>
  private memberships: ExportMembership

  private constructor(
    private readonly handle: RecordKindHandle<HaExportTargetBody>,
    rows: ReadonlyMap<string, HaExportTargetBody>,
  ) {
    this.rows = rows
    this.memberships = membershipOf(rows)
  }

  /** A failed read throws: serving an empty set would unexport every device on the next pass. */
  static async load(handle: RecordKindHandle<HaExportTargetBody>): Promise<ExportTargets> {
    return new ExportTargets(handle, await readAllTargets(handle))
  }

  /** Re-read the records after the instance door changed one; a failed read keeps the old copy. */
  async reload(): Promise<void> {
    this.adopt(await readAllTargets(this.handle))
  }

  ids(): readonly string[] {
    return [...this.rows.keys()]
  }

  has(id: string): boolean {
    return this.rows.has(id)
  }

  get(id: string): HaExportTargetBody | undefined {
    return this.rows.get(id)
  }

  name(id: string): string {
    return this.rows.get(id)?.name ?? id
  }

  /** The target's own switch; an absent field means on. */
  isEnabled(id: string): boolean {
    const row = this.rows.get(id)
    return row !== undefined && row.enabled !== false
  }

  connectionId(id: string): string {
    return this.rows.get(id)?.connectionId ?? ''
  }

  mediaRole(id: string): HaMediaRole {
    return this.rows.get(id)?.mediaRole ?? 'publicEndpoint'
  }

  /** The cadence of the quickest enabled target (the addon runs one timer); the default when none. */
  reconcileIntervalSec(): number {
    const seconds = [...this.rows.values()]
      .filter((row) => row.enabled !== false)
      .map((row) => row.reconcileIntervalSec)
    if (seconds.length === 0) return DEFAULT_RECONCILE_INTERVAL_SEC
    return Math.max(MIN_RECONCILE_INTERVAL_SEC, Math.min(...seconds))
  }

  /** targetId → exported device ids, for the targets that export at least one. */
  membership(): ExportMembership {
    return this.memberships
  }

  /**
   * Persist the device lists that differ from the held ones. A target that does not exist is
   * never created here (an id the records do not hold is refused by the caller).
   */
  async setMembership(next: ExportMembership): Promise<void> {
    let rows = this.rows
    for (const id of new Set([...Object.keys(next), ...Object.keys(this.memberships)])) {
      const current = rows.get(id)
      if (current === undefined) continue
      const devices = next[id] ?? []
      if (sameList(current.devices, devices)) continue
      await this.handle.patch(id, { devices: [...devices] })
      rows = new Map(rows).set(id, { ...current, devices: [...devices] })
      this.adopt(rows)
    }
  }

  private adopt(rows: ReadonlyMap<string, HaExportTargetBody>): void {
    const ids = new Set([...rows.keys(), ...this.rows.keys()])
    const devicesChanged = [...ids].some(
      (id) => !sameList(rows.get(id)?.devices ?? [], this.rows.get(id)?.devices ?? []),
    )
    this.rows = rows
    if (devicesChanged) this.memberships = membershipOf(rows)
  }
}
