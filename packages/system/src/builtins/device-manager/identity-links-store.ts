/**
 * The `identity-links` record kind (D1063), held in memory once read.
 *
 * Links are few (a pair per matched device), so the store reads them all once
 * and keeps the working copy here; every write goes to the record first and
 * lands in the map only when it succeeded. Until {@link load} has answered, it
 * says so — `not-loaded` is never an empty list (D315).
 */
import type {
  IdentityLink,
  IdentityLinkBody,
  RecordKindHandle,
  RecordsAccess,
} from '@dominevo/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { deviceManagerRecordKinds } from './record-kinds.js'

export class IdentityLinksStore {
  private links: Map<string, IdentityLink> | null = null

  constructor(private readonly kind: RecordKindHandle<IdentityLinkBody>) {}

  static of(records: Pick<RecordsAccess, 'kind'>): IdentityLinksStore {
    return new IdentityLinksStore(records.kind(deviceManagerRecordKinds['identity-links']))
  }

  async load(): Promise<void> {
    const rows = await readAllRows(this.kind)
    this.links = new Map(rows.map((row) => [row.id, { id: row.id, ...row.data }]))
  }

  isLoaded(): boolean {
    return this.links !== null
  }

  /** Every link; `null` until loaded. */
  list(): readonly IdentityLink[] | null {
    return this.links === null ? null : [...this.links.values()]
  }

  get(id: string): IdentityLink | null {
    return this.links?.get(id) ?? null
  }

  async put(link: IdentityLink): Promise<void> {
    const { id, ...data } = link
    await this.kind.put({ id, data })
    this.links?.set(id, link)
  }

  async delete(id: string): Promise<void> {
    await this.kind.delete(id)
    this.links?.delete(id)
  }
}
