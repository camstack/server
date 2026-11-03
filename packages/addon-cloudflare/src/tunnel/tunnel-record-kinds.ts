/**
 * The Cloudflare tunnel as a record (D985, D996): ONE `tunnels` row, owned by `cloudflare-tunnel`
 * and named after it, listed on the Remote Access page. The API token and the tunnel token the
 * addon mints are keychain markers bound to the row. Where the tunnel forwards to (`localHost`,
 * `localPortMode`, `localPort`) is NOT here: it is a fact of the node (D986).
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

/** A single-instance addon keeps its record under its own addon id. */
export const CLOUDFLARE_TUNNEL_RECORD_ID = 'cloudflare-tunnel'

export type TunnelMode = 'quick' | 'custom'
export type TunnelProtocol = 'auto' | 'http2' | 'quic'

export type CloudflareTunnelBody = {
  readonly name: string
  /** `quick` = a random trycloudflare URL; `custom` = a named tunnel on the operator's zone. */
  readonly mode: TunnelMode
  /** The Cloudflare API token used to provision and manage the tunnel (bearer credential). */
  readonly customApiToken?: string | undefined
  /** The named-tunnel JWT the addon provisions itself (bearer credential). */
  readonly customTunnelToken?: string | undefined
  readonly customAccountId: string
  readonly customTunnelId: string
  readonly customZoneId: string
  readonly customZoneName: string
  readonly customDnsRecordId: string
  /** The sub-domain, or the fully-qualified hostname once provisioned. */
  readonly customHostname: string
  /** Skip TLS verification on the cloudflared to origin hop (the hub's cert is self-signed). */
  readonly noTLSVerify: boolean
  readonly originServerName: string
  readonly httpHostHeader: string
  readonly debugLogging: boolean
  readonly protocol: TunnelProtocol
  /** The instance's own switch (D996). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const CloudflareTunnelBodySchema: z.ZodType<CloudflareTunnelBody> = z.object({
  name: z.string().min(1),
  mode: z.enum(['quick', 'custom']),
  customApiToken: z.string().optional().meta({ secret: true }),
  customTunnelToken: z.string().optional().meta({ secret: true }),
  customAccountId: z.string(),
  customTunnelId: z.string(),
  customZoneId: z.string(),
  customZoneName: z.string(),
  customDnsRecordId: z.string(),
  customHostname: z.string(),
  noTLSVerify: z.boolean(),
  originServerName: z.string(),
  httpHostHeader: z.string(),
  debugLogging: z.boolean(),
  protocol: z.enum(['auto', 'http2', 'quic']),
  enabled: z.boolean().optional(),
})

export const TUNNELS_KIND_NAME = 'tunnels'

export const cloudflareTunnelsKind: DefinedRecordKind<z.ZodType<CloudflareTunnelBody>> =
  defineEntryKind(TUNNELS_KIND_NAME, {
    title: 'Cloudflare tunnel',
    nameField: 'name',
    schema: CloudflareTunnelBodySchema,
  })

/** What a tunnel starts as: the defaults the addon's constructor used to carry. */
export const CLOUDFLARE_TUNNEL_DEFAULT_BODY: Omit<CloudflareTunnelBody, 'name'> = {
  mode: 'quick',
  customAccountId: '',
  customTunnelId: '',
  customZoneId: '',
  customZoneName: '',
  customDnsRecordId: '',
  customHostname: 'camstack',
  noTLSVerify: true,
  originServerName: '',
  httpHostHeader: '',
  debugLogging: false,
  protocol: 'auto',
}

/** The tunnel settings moved out of the addon settings into the record; the migrations name them. */
export const MOVED_TUNNEL_KEYS = [
  'mode',
  'customApiToken',
  'customTunnelToken',
  'customAccountId',
  'customTunnelId',
  'customZoneId',
  'customZoneName',
  'customDnsRecordId',
  'customHostname',
  'noTLSVerify',
  'originServerName',
  'httpHostHeader',
  'debugLogging',
  'protocol',
] as const

/** The node facts: where the tunnel forwards to is a property of the node that runs it (D986). */
export const NODE_ORIGIN_KEYS = ['localHost', 'localPortMode', 'localPort'] as const
