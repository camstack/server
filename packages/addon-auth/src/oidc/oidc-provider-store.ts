import {
  type RecordKindHandle,
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
      let data = record.data
      try {
        const resolved = await this.kind.getResolved(record.id)
        if (resolved !== null) data = resolved.data
      } catch (err: unknown) {
        if (!(err instanceof RecordSecretUnavailableError)) throw err
      }
      const parsed = OidcProviderBodySchema.safeParse(data)
      if (!parsed.success) continue
      out.push(rowToProvider(record.id, parsed.data))
    }
    return out
  }

  /** Delete one provider record; no other row (nor its secrets) is touched. */
  async remove(id: string): Promise<void> {
    await this.kind.delete(id)
  }

  async replaceAll(providers: readonly OidcProviderRow[]): Promise<void> {
    const page = await this.kind.query({ limit: 1000 })
    const nextIds = new Set(providers.map((p) => p.id))
    for (const row of page.records) {
      if (!nextIds.has(row.id)) await this.kind.delete(row.id)
    }
    for (const row of providers) {
      const {
        id,
        displayName,
        icon,
        issuerUrl,
        clientId,
        clientSecret,
        redirectUri,
        scopes,
        usernameClaim,
      } = row
      const body = {
        displayName,
        icon,
        issuerUrl,
        clientId,
        clientSecret,
        redirectUri,
        scopes,
        usernameClaim,
      }
      const parsed = oidcProviderEntryKind.schema.safeParse(body)
      if (!parsed.success) {
        throw new Error(`invalid OIDC provider '${id}': ${parsed.error.message}`)
      }
      await this.kind.put({ id, data: parsed.data })
    }
  }
}

export { OIDC_PROVIDER_KIND }
