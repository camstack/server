import {
  type RecordKindHandle,
  type RecordRow,
  type RecordsAccess,
  RecordSecretUnavailableError,
} from '@camstack/types'
import {
  oidcProviderEntryKind,
  OidcProviderBodySchema,
  type OidcProviderBody,
  OIDC_PROVIDER_KIND,
} from './oidc-provider-record-kinds.js'
import { DEFAULT_OIDC_PROVIDER, type OidcProviderRow } from './oidc-connections.js'

function rowToProvider(id: string, data: OidcProviderBody): OidcProviderRow {
  return {
    ...DEFAULT_OIDC_PROVIDER,
    ...data,
    id,
  }
}

/** Fields of a row patch; `clientSecret: null` clears the stored secret. */
export type OidcProviderPatch = {
  readonly displayName?: string
  readonly icon?: string
  readonly issuerUrl?: string
  readonly clientId?: string
  readonly clientSecret?: string | null
  readonly redirectUri?: string
  readonly scopes?: string
  readonly usernameClaim?: OidcProviderBody['usernameClaim']
}

/** The stored body of a row; an empty or non-text secret is left out. */
function bodyOf(row: OidcProviderRow): Record<string, unknown> {
  const { id: _id, clientSecret, ...rest } = row
  return typeof clientSecret === 'string' && clientSecret !== '' ? { ...rest, clientSecret } : rest
}

export class OidcProviderStore {
  private readonly kind: RecordKindHandle<OidcProviderBody>

  constructor(kind: RecordKindHandle<OidcProviderBody>) {
    this.kind = kind
  }

  static of(records: Pick<RecordsAccess, 'kind'>): OidcProviderStore {
    return new OidcProviderStore(records.kind(oidcProviderEntryKind))
  }

  async listResolved(): Promise<OidcProviderRow[]> {
    const page = await this.kind.query({ limit: 1000 })
    const out: OidcProviderRow[] = []
    for (const record of page.records) {
      const row = await this.getResolved(record.id)
      if (row !== null) out.push(row)
    }
    return out
  }

  /** One row with its secret resolved for the runtime token call; null when absent. */
  async getResolved(id: string): Promise<OidcProviderRow | null> {
    let record: RecordRow<OidcProviderBody> | null
    try {
      record = await this.kind.getResolved(id)
    } catch (err: unknown) {
      if (!(err instanceof RecordSecretUnavailableError)) throw err
      const stored = await this.kind.get(id)
      if (stored === null) return null
      // The keychain is locked: serve the row WITHOUT a secret, never the marker.
      const { clientSecret: _unreadable, ...rest } = stored.data
      record = { ...stored, data: rest }
    }
    if (record === null) return null
    const parsed = OidcProviderBodySchema.safeParse(record.data)
    return parsed.success ? rowToProvider(id, parsed.data) : null
  }

  /**
   * Insert ONE new row (`ifRev: 0`: an existing id is refused). A plaintext
   * `clientSecret` is stored by the records facade under the row's own ref.
   */
  async create(row: OidcProviderRow): Promise<OidcProviderRow> {
    const body = bodyOf(row)
    const parsed = OidcProviderBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new Error(`invalid OIDC provider '${row.id}': ${parsed.error.message}`)
    }
    await this.kind.put({ id: row.id, data: parsed.data }, { ifRev: 0 })
    return this.requireRow(row.id)
  }

  /**
   * Merge a partial into ONE row. `clientSecret`: a plaintext sets it, `undefined`
   * keeps the stored one, `null` clears it.
   */
  async update(id: string, partial: OidcProviderPatch): Promise<OidcProviderRow> {
    await this.kind.patch(id, partial)
    return this.requireRow(id)
  }

  /** Delete one provider record; no other row (nor its secrets) is touched. */
  async remove(id: string): Promise<void> {
    await this.kind.delete(id)
  }

  private async requireRow(id: string): Promise<OidcProviderRow> {
    const row = await this.getResolved(id)
    if (row === null) throw new Error(`OIDC provider '${id}' is not readable after the write`)
    return row
  }
}

export { OIDC_PROVIDER_KIND }
