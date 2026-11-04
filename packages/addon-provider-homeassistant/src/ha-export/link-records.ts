/**
 * What the export carries to one Home Assistant instance (planning#408 P4): an `ha-export-links`
 * record per instance, under the id of the Home Assistant broker it belongs to. It holds the
 * three facts of the link: whether the export reaches the instance, which hub address role its
 * image links use, and the devices exported to it.
 *
 * It replaces the `membership` setting, the `exportTo:<brokerId>` / `mediaRole:<brokerId>` keys
 * and the `exportTo` / `mediaRole` values of the instance's integration. The migration moved
 * them; the addon reads this record and nothing else.
 */
import { type DefinedRecordKind, defineEntryKind, type RecordKindHandle } from '@camstack/types'
import { z } from 'zod'
import type { ExportMembership } from './membership.js'
import { HA_MEDIA_ROLES, type HaMediaRole } from './media-url.js'

export const HA_EXPORT_LINKS_KIND_NAME = 'ha-export-links'

export type HaExportLinksBody = {
  readonly name: string
  readonly exportTo: boolean
  readonly mediaRole: HaMediaRole
  readonly devices: readonly string[]
}

export const HaExportLinksBodySchema: z.ZodType<HaExportLinksBody> = z.object({
  name: z.string().min(1),
  exportTo: z.boolean(),
  mediaRole: z.enum(HA_MEDIA_ROLES),
  devices: z.array(z.string()),
})

export const haExportLinksKind: DefinedRecordKind<z.ZodType<HaExportLinksBody>> = defineEntryKind(
  HA_EXPORT_LINKS_KIND_NAME,
  {
    title: 'Home Assistant export links',
    nameField: 'name',
    schema: HaExportLinksBodySchema,
    writeTrigger:
      'an operator switches the export of a Home Assistant instance, picks its image-link address, or exports a device to it',
  },
)

/** A link the operator has not touched: off, on the internal address, no device. */
export function defaultLinks(name: string): HaExportLinksBody {
  return { name, exportTo: false, mediaRole: 'internal', devices: [] }
}

/** Every record of the kind, once; a failed read throws (the caller must not serve "nothing"). */
export async function readAllLinks(
  handle: RecordKindHandle<HaExportLinksBody>,
): Promise<ReadonlyMap<string, HaExportLinksBody>> {
  const rows = new Map<string, HaExportLinksBody>()
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

function membershipOf(rows: ReadonlyMap<string, HaExportLinksBody>): ExportMembership {
  const out: Record<string, readonly string[]> = {}
  for (const [brokerId, row] of rows) if (row.devices.length > 0) out[brokerId] = row.devices
  return out
}

/**
 * The in-memory copy of the records. This addon is their only writer, so the copy is the
 * synchronous read the event path needs; a write lands in the record first and in the copy
 * after it. `membership()` keeps its identity until a device list changes.
 */
export class ExportLinks {
  private rows: ReadonlyMap<string, HaExportLinksBody>
  private memberships: ExportMembership

  private constructor(
    private readonly handle: RecordKindHandle<HaExportLinksBody>,
    rows: ReadonlyMap<string, HaExportLinksBody>,
  ) {
    this.rows = rows
    this.memberships = membershipOf(rows)
  }

  static async load(handle: RecordKindHandle<HaExportLinksBody>): Promise<ExportLinks> {
    return new ExportLinks(handle, await readAllLinks(handle))
  }

  isEnabled(brokerId: string): boolean {
    return this.rows.get(brokerId)?.exportTo === true
  }

  mediaRole(brokerId: string): HaMediaRole {
    return this.rows.get(brokerId)?.mediaRole ?? 'internal'
  }

  /** brokerId → exported device ids, for the brokers that export at least one. */
  membership(): ExportMembership {
    return this.memberships
  }

  brokerIds(): readonly string[] {
    return [...this.rows.keys()]
  }

  /** Change the switch and / or the role of one instance; creates the record on first use. */
  async setFlags(
    brokerId: string,
    name: string,
    patch: { readonly exportTo?: boolean; readonly mediaRole?: HaMediaRole },
  ): Promise<void> {
    const current = this.rows.get(brokerId) ?? defaultLinks(name)
    const next: HaExportLinksBody = {
      ...current,
      exportTo: patch.exportTo ?? current.exportTo,
      mediaRole: patch.mediaRole ?? current.mediaRole,
    }
    if (this.rows.has(brokerId) && sameLinks(current, next)) return
    await this.write(brokerId, next)
  }

  /** Persist the device lists that differ from the held ones; returns nothing to do as a no-op. */
  async setMembership(next: ExportMembership, nameOf: (brokerId: string) => string): Promise<void> {
    for (const brokerId of new Set([...Object.keys(next), ...Object.keys(this.memberships)])) {
      const devices = next[brokerId] ?? []
      const current = this.rows.get(brokerId)
      if (sameList(current?.devices ?? [], devices)) continue
      await this.write(brokerId, {
        ...(current ?? defaultLinks(nameOf(brokerId))),
        devices: [...devices],
      })
    }
  }

  /** Forget the instances that no longer exist; returns the ids it removed. */
  async prune(knownBrokerIds: readonly string[]): Promise<readonly string[]> {
    const known = new Set(knownBrokerIds)
    const gone = [...this.rows.keys()].filter((id) => !known.has(id))
    for (const id of gone) await this.handle.delete(id)
    if (gone.length > 0) this.adopt(new Map([...this.rows].filter(([id]) => known.has(id))))
    return gone
  }

  private async write(brokerId: string, body: HaExportLinksBody): Promise<void> {
    await this.handle.put({ id: brokerId, data: body })
    this.adopt(new Map(this.rows).set(brokerId, body))
  }

  private adopt(rows: ReadonlyMap<string, HaExportLinksBody>): void {
    const ids = new Set([...rows.keys(), ...this.rows.keys()])
    const devicesChanged = [...ids].some(
      (id) => !sameList(rows.get(id)?.devices ?? [], this.rows.get(id)?.devices ?? []),
    )
    this.rows = rows
    if (devicesChanged) this.memberships = membershipOf(rows)
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameLinks(a: HaExportLinksBody, b: HaExportLinksBody): boolean {
  return a.exportTo === b.exportTo && a.mediaRole === b.mediaRole && sameList(a.devices, b.devices)
}

/**
 * The settings form names an instance's two facts as the dynamic keys `exportTo:<brokerId>` and
 * `mediaRole:<brokerId>`. They are form fields, not stored keys: a read overlays them from the
 * records and a write is routed to the record of the broker they name.
 */
export const exportToFormKey = (brokerId: string): string => `exportTo:${brokerId}`
export const mediaRoleFormKey = (brokerId: string): string => `mediaRole:${brokerId}`

export type LinkFormField =
  | { readonly flag: 'exportTo'; readonly brokerId: string }
  | { readonly flag: 'mediaRole'; readonly brokerId: string }

export function parseLinkFormKey(key: string): LinkFormField | null {
  for (const flag of ['exportTo', 'mediaRole'] as const) {
    const prefix = `${flag}:`
    if (key.startsWith(prefix) && key.length > prefix.length) {
      return { flag, brokerId: key.slice(prefix.length) }
    }
  }
  return null
}

/** The form's dynamic keys carrying each instance's own value. */
export function linkFormOverlay(links: ExportLinks): Record<string, unknown> {
  const overlay: Record<string, unknown> = {}
  for (const brokerId of links.brokerIds()) {
    overlay[exportToFormKey(brokerId)] = links.isEnabled(brokerId)
    overlay[mediaRoleFormKey(brokerId)] = links.mediaRole(brokerId)
  }
  return overlay
}
