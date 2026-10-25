/**
 * Cloudflare API client — Tunnel + DNS Zones operations needed by the
 * Custom-tunnel flow.
 *
 * Auth: user-pasted API token (created once in the Cloudflare dashboard
 *       with `Account.Cloudflare Tunnel:Edit` + `Zone.DNS:Edit` scopes).
 *       The token is treated as opaque and never logged.
 *
 * Endpoints used:
 *   - GET  /accounts                                           — discover account id
 *   - GET  /zones                                              — list zones (interactive picker)
 *   - POST /accounts/{accountId}/cfd_tunnel                    — create tunnel
 *   - DELETE /accounts/{accountId}/cfd_tunnel/{id}             — delete tunnel
 *   - PUT  /accounts/{accountId}/cfd_tunnel/{id}/configurations — set ingress
 *   - POST /zones/{zoneId}/dns_records                         — create CNAME
 *   - DELETE /zones/{zoneId}/dns_records/{id}                  — cleanup
 *
 * The wrappers throw `CloudflareApiError` with the `code` + first `message`
 * from the response envelope so callers can surface actionable errors
 * (e.g. "Invalid API token" vs "Insufficient permissions").
 */
import { randomUUID } from 'node:crypto'

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareZone {
  readonly id: string
  readonly name: string
  readonly status: string
  /** Present on zone responses; lets us derive the account id without
   *  needing User:Read on the token. */
  readonly account?: { readonly id: string; readonly name: string }
}

export interface CloudflareAccount {
  readonly id: string
  readonly name: string
}

export interface CloudflareTunnel {
  readonly id: string
  readonly name: string
  readonly token: string
  readonly accountTag: string
}

export interface CloudflareTunnelOriginRequest {
  /** Skip TLS verification on the upstream — required for self-signed certs. */
  readonly noTLSVerify?: boolean
  /** Override the Host header sent to the upstream service. */
  readonly httpHostHeader?: string
  /** SNI to send during the TLS handshake to the upstream. */
  readonly originServerName?: string
}

export interface CloudflareTunnelIngress {
  readonly hostname?: string
  readonly service: string
  readonly path?: string
  readonly originRequest?: CloudflareTunnelOriginRequest
}

export interface CloudflareDnsRecord {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly type: string
}

export class CloudflareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | undefined,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message)
    this.name = 'CloudflareApiError'
  }
}

interface CloudflareEnvelope<T> {
  readonly success: boolean
  readonly errors?: readonly { code: number; message: string }[]
  readonly result?: T
}

export class CloudflareApi {
  constructor(private readonly token: string) {}

  /**
   * Resolve the account behind the token.
   *
   * Cloudflare's `GET /accounts` requires `User:Read` (or a multi-account
   * token); a token scoped narrowly to `Account → Cloudflare Tunnel:Edit
   * + Zone → DNS:Edit` on a single account returns an empty list. We
   * fall back to listing zones and reading `zone.account` — zones always
   * carry account metadata so this works regardless of token scopes.
   */
  async getAccount(): Promise<CloudflareAccount> {
    try {
      const accounts = await this.req<readonly CloudflareAccount[]>('GET', '/accounts')
      if (accounts.length > 0) return accounts[0]!
    } catch (err) {
      // 403 (token has no User:Read) is the common case here — fall
      // through to the zone-based derivation rather than surfacing it
      // to the operator.
      if (!(err instanceof CloudflareApiError) || err.status !== 403) throw err
    }

    const zones = await this.listZones()
    for (const z of zones) {
      if (z.account?.id) return { id: z.account.id, name: z.account.name ?? z.account.id }
    }
    throw new CloudflareApiError(
      404,
      undefined,
      'Token cannot reach any account — make sure it has Account → Cloudflare Tunnel:Edit AND Zone → DNS:Edit',
    )
  }

  /** List every zone the token can reach. */
  async listZones(): Promise<readonly CloudflareZone[]> {
    return this.req<readonly CloudflareZone[]>('GET', '/zones?per_page=50')
  }

  /**
   * Look up an existing tunnel by name. Returns the first non-deleted
   * match. Used by `enableCustom` to make tunnel creation idempotent —
   * a previous attempt that crashed mid-flow may have left a
   * 'camstack' tunnel behind; this lets us reuse / delete-and-recreate
   * rather than failing with "tunnel with this name already exists".
   */
  async findTunnelByName(accountId: string, name: string): Promise<CloudflareTunnel | null> {
    const list = await this.req<readonly CloudflareTunnel[]>(
      'GET',
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    )
    return list.length > 0 ? list[0]! : null
  }

  /**
   * Cloudflare's `GET /accounts/{id}/cfd_tunnel/{id}/token` returns the
   * connector JWT for an existing tunnel. We use it when reusing a
   * previously-created tunnel — the create-tunnel response embeds the
   * token, but lookups by name only return metadata.
   */
  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.req<string>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)
  }

  async createTunnel(accountId: string, name: string): Promise<CloudflareTunnel> {
    return this.req<CloudflareTunnel>('POST', `/accounts/${accountId}/cfd_tunnel`, {
      name,
      // Cloudflare requires a random tunnel_secret (base64, ≥32 bytes) for
      // legacy clients. The new `--token` flow embeds creds in the JWT
      // returned by the create call; the secret is still required by the
      // API contract but is unused by `cloudflared run --token`.
      tunnel_secret: Buffer.from(randomUUID() + randomUUID()).toString('base64'),
      config_src: 'cloudflare',
    })
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.req<unknown>('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
  }

  async putTunnelConfiguration(
    accountId: string,
    tunnelId: string,
    ingress: readonly CloudflareTunnelIngress[],
  ): Promise<void> {
    await this.req<unknown>('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: { ingress },
    })
  }

  async createDnsRecord(
    zoneId: string,
    record: { name: string; content: string; type: 'CNAME' | 'A'; proxied?: boolean },
  ): Promise<CloudflareDnsRecord> {
    return this.req<CloudflareDnsRecord>('POST', `/zones/${zoneId}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: record.proxied ?? true,
      ttl: 1, // automatic (Cloudflare-managed when proxied)
    })
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.req<unknown>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`)
  }

  /**
   * Find an existing DNS record by name. Returns the first match.
   * Used by `enableCustom` to detect + repair stale CNAMEs that point
   * to a previously-deleted tunnel id (one of the common 1033 causes).
   */
  async findDnsRecord(zoneId: string, name: string): Promise<CloudflareDnsRecord | null> {
    const list = await this.req<readonly CloudflareDnsRecord[]>(
      'GET',
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    )
    return list.length > 0 ? list[0]! : null
  }

  /**
   * Rewrite the `content` (CNAME target) and `proxied` flag of an
   * existing record. Cloudflare allows PATCH so partial updates are
   * cheaper than create+delete.
   */
  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    patch: { content?: string; proxied?: boolean; type?: 'CNAME' | 'A' },
  ): Promise<CloudflareDnsRecord> {
    return this.req<CloudflareDnsRecord>('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, patch)
  }

  /**
   * List every cfd_tunnel in the account. Used by the cleanup action
   * to find stale "camstack" tunnels left behind by a previous crash
   * or an operator who manually re-created the tunnel from the
   * Cloudflare dashboard.
   */
  async listTunnels(
    accountId: string,
    opts?: { name?: string },
  ): Promise<readonly CloudflareTunnel[]> {
    const qs = new URLSearchParams({ is_deleted: 'false', per_page: '50' })
    if (opts?.name) qs.set('name', opts.name)
    return this.req<readonly CloudflareTunnel[]>(
      'GET',
      `/accounts/${accountId}/cfd_tunnel?${qs.toString()}`,
    )
  }

  // ── Internals ──────────────────────────────────────────────────

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: CloudflareEnvelope<T> | undefined
    try {
      parsed = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : undefined
    } catch {
      parsed = undefined
    }
    if (!res.ok || !parsed?.success) {
      const firstError = parsed?.errors?.[0]
      throw new CloudflareApiError(
        res.status,
        firstError?.code,
        firstError?.message ?? `Cloudflare API ${method} ${path} failed (${res.status})`,
        parsed,
      )
    }
    return parsed.result as T
  }
}
