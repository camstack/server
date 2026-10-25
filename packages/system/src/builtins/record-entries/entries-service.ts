/**
 * The entries service (D881): one list/add/edit/delete surface for every entry
 * kind an addon declares (`defineEntryKind`). It holds no data and no schema of
 * its own - the engine's catalog is the source (`storageAdmin.listKinds`), and
 * each call acts for the entry's OWNER through `ctx.records.forOwner`, so the
 * owner's keychain refs and the owner-only rule of records both hold.
 *
 * The body is validated against the kind's JSON Schema descriptor
 * (`z.fromJSONSchema`), so a form can only save what the owner's own schema
 * describes. A password field is whatever the schema marks `secret: true`.
 */
import { randomUUID } from 'node:crypto'
import {
  type DefinedRecordKind,
  type EntryKindInfo,
  type EntryView,
  InvalidRecordError,
  mapSecretLeaves,
  recordSecretRef,
  REDACTED_SECRET,
  type RecordsAccess,
  type SecretFieldView,
  type StorageKind,
  UnknownRecordKindError,
} from '@camstack/types'
import { z } from 'zod'

/** Entries one list answers: an entries list is a settings page, not a table. */
export const ENTRIES_LIST_MAX = 2000

export interface EntriesServiceDeps {
  /** Every record kind of the engine; `counts: false` is a catalog read with no row counting. */
  listKinds(counts: boolean): Promise<readonly StorageKind[]>
  /** The records door of `owner` (hub in-process builtins only). */
  recordsFor(owner: string): RecordsAccess
  newId?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A stored secret, as an entries read shows it: a VIEW naming the row's own
 * keychain ref (`set: true`), never the value and no longer the bare redaction
 * token. The form hands it to the secret field, which reveals the value by
 * ref through the audited `keychain-admin.reveal`; sent back untouched it
 * keeps the stored secret (the records door reads a view as KEEP).
 */
function secretViewsOf(
  owner: string,
  kind: string,
  id: string,
  info: StorageKind,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const decl = info.declaration
  if (decl.secretPaths.length === 0) return data
  const shown = mapSecretLeaves(data, decl.secretPaths, decl.secretArrayKeys, (leaf) => {
    if (leaf.value !== REDACTED_SECRET) return leaf.value
    const view: SecretFieldView = {
      $secret: recordSecretRef(owner, kind, id, leaf.concrete),
      v: 1,
      set: true,
    }
    return view
  })
  return isRecord(shown) ? shown : data
}

export class EntriesService {
  constructor(private readonly deps: EntriesServiceDeps) {}

  private async entryKind(owner: string, kind: string): Promise<StorageKind> {
    const found = (await this.deps.listKinds(false)).find(
      (k) => k.owner === owner && k.kind === kind && k.declaration.entry !== undefined,
    )
    if (found === undefined) {
      throw new UnknownRecordKindError(`"${owner}" declared no entry kind "${kind}"`)
    }
    return found
  }

  private definitionOf(info: StorageKind): DefinedRecordKind<z.ZodType<Record<string, unknown>>> {
    const entry = info.declaration.entry
    if (entry === undefined) throw new UnknownRecordKindError(`"${info.kind}" is not an entry kind`)
    const body = z.fromJSONSchema(entry.fields)
    const schema = z.custom<Record<string, unknown>>(
      (value) => isRecord(value) && body.safeParse(value).success,
      { message: "the entry does not match the kind's schema" },
    )
    return { name: info.kind, schema, declaration: info.declaration }
  }

  async listEntryKinds(): Promise<{ kinds: EntryKindInfo[] }> {
    const kinds = (await this.deps.listKinds(true))
      .filter((k) => k.declaration.entry !== undefined && k.state === 'declared')
      .map((k): EntryKindInfo => {
        const entry = k.declaration.entry
        return {
          owner: k.owner,
          kind: k.kind,
          title: entry?.title ?? k.kind,
          nameField: entry?.nameField ?? 'name',
          fields: entry?.fields ?? {},
          secretPaths: k.declaration.secretPaths,
          rows: k.rows ?? 0,
        }
      })
    return { kinds }
  }

  async listEntries(input: { owner: string; kind: string }): Promise<{ entries: EntryView[] }> {
    const info = await this.entryKind(input.owner, input.kind)
    const nameField = info.declaration.entry?.nameField ?? 'name'
    const handle = this.deps.recordsFor(input.owner).kind(this.definitionOf(info))
    const entries: EntryView[] = []
    let cursor: string | undefined
    do {
      const page = await handle.query({
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
        order: 'id',
      })
      for (const row of page.records) {
        const name = row.data[nameField]
        entries.push({
          id: row.id,
          name: typeof name === 'string' ? name : row.id,
          rev: row.rev,
          updatedAt: row.updatedAt,
          data: secretViewsOf(input.owner, input.kind, row.id, info, row.data),
        })
      }
      cursor = page.nextCursor ?? undefined
      if (entries.length > ENTRIES_LIST_MAX) {
        throw new InvalidRecordError(`${input.kind}: more than ${ENTRIES_LIST_MAX} entries`)
      }
    } while (cursor !== undefined)
    return { entries }
  }

  async putEntry(input: {
    owner: string
    kind: string
    id?: string | undefined
    data: Record<string, unknown>
    ifRev?: number | undefined
  }): Promise<{ id: string; rev: number }> {
    const info = await this.entryKind(input.owner, input.kind)
    const handle = this.deps.recordsFor(input.owner).kind(this.definitionOf(info))
    const id = input.id ?? (this.deps.newId ?? randomUUID)()
    // A new entry must not overwrite an existing id; an edit is guarded by its rev when given.
    const ifRev = input.id === undefined ? 0 : input.ifRev
    const { rev } = await handle.put({ id, data: input.data }, ifRev === undefined ? {} : { ifRev })
    return { id, rev }
  }

  async deleteEntry(input: {
    owner: string
    kind: string
    id: string
  }): Promise<{ deleted: boolean }> {
    const info = await this.entryKind(input.owner, input.kind)
    const handle = this.deps.recordsFor(input.owner).kind(this.definitionOf(info))
    return { deleted: await handle.delete(input.id) }
  }
}
