import type { NodegreeOptions } from '@apocaliss92/nodegree'
import type { ConfigUISchema } from '@camstack/types'
import { z } from 'zod'

/**
 * The AES negotiation modes the wrapped `@apocaliss92/nodegree` client accepts.
 * Mirrors the library's `encryption` union — kept local so the addon validates
 * the operator-supplied value at the system boundary without importing a runtime
 * value the library does not export. `auto` tries V2 (GCM) then V1 (ECB).
 */
export const GREE_ENCRYPTION_MODES = ['auto', 'v1', 'v2'] as const
export const GreeEncryptionSchema = z.enum(GREE_ENCRYPTION_MODES)
export type GreeEncryptionValue = z.infer<typeof GreeEncryptionSchema>

/**
 * Operator-supplied CONNECTION for ONE Gree air conditioner (standalone mode —
 * the Reolink / Ecowitt pattern). Gree is LOCAL-ONLY (a directed-broadcast bind
 * handshake + per-device AES control over UDP), so the connection carries no
 * credentials — only the AC's LAN address and the UDP tuning knobs. The
 * `broadcastAddr` is the directed target the bind scan is aimed at: point it at
 * the AC's own IP (unicast-directed) or the subnet broadcast (e.g.
 * `192.168.10.255`). Empty = the library's default global broadcast.
 */
export const greeConfigSchema = z.object({
  /** The AC's LAN IP address — the directed-bind target. Required for a manual
   *  standalone add (the operator types it). */
  host: z.string().default('').describe('Air conditioner LAN IP address'),
  /** Directed broadcast address for the bind scan (e.g. `192.168.10.255`). Empty =
   *  the library's default global broadcast; when a `host` is set the scan is
   *  aimed at it directly. */
  broadcastAddr: z.string().default('').describe('Directed broadcast address for the bind scan'),
  /** UDP request timeout in ms. */
  timeoutMs: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(500).max(30_000).default(3_000),
    )
    .describe('UDP request timeout (ms)'),
  /** Retry count per UDP request. */
  retries: z
    .preprocess(
      (v) => (v === '' || v === null ? undefined : v),
      z.number().int().min(0).max(10).default(3),
    )
    .describe('Retries per UDP request'),
  /** AES negotiation mode. */
  encryption: GreeEncryptionSchema.default('auto').describe('AES cipher negotiation'),
})

export type GreeConfig = z.infer<typeof greeConfigSchema>

/**
 * Build the `NodegreeOptions` the wrapped client constructor expects from the
 * validated connection. Pure: same config in → same options out. `host` and
 * `broadcastAddr` are NOT constructor options — they are passed to `discover()`
 * per scan — so they are intentionally omitted here.
 */
export function toNodegreeOptions(config: GreeConfig): NodegreeOptions {
  return {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    encryption: config.encryption,
  }
}

/**
 * Coerce a loose settings blob (the manual-creation form values, or a persisted
 * `connection` blob) through the connection schema, applying all defaults.
 * Throws a `ZodError` on invalid input so the caller surfaces a clear error at
 * the system boundary.
 */
export function settingsToGreeConfig(settings: unknown): GreeConfig {
  return greeConfigSchema.parse(settings ?? {})
}

// ---------------------------------------------------------------------------
// Air-conditioner device persisted config (standalone mode)
// ---------------------------------------------------------------------------

/**
 * Persisted config for a Gree AC {@link import('@camstack/types').DeviceType.Container}
 * device. The operator-supplied CONNECTION lives directly on the device (Reolink
 * pattern) — there is no broker registry. The device owns its own live
 * `@apocaliss92/nodegree` client keyed on its own `connectionKey`; its AC +
 * toggle accessory children resolve the bound handle via that key.
 *
 * `greeMac` is the durable device identity (resolved by the create-time bind);
 * `greeIp` is the last-known LAN address; `connectionKey` is the per-device
 * connection-resolver key (the device's own stableId — decoupled from any
 * broker); `connection` is the operator's UDP settings; `system`/`name` are
 * provenance.
 */
export const greeAcDeviceSchema = z.object({
  /** Durable AC identity (MAC, lowercased) resolved by the create-time bind. */
  greeMac: z.string().min(1).describe('Gree AC MAC address'),
  /** Last-known LAN IP (re-bound on each activate). */
  greeIp: z.string().optional().describe('Last known LAN IP'),
  /** Per-device connection-resolver key (the device's own stableId). */
  connectionKey: z.string().min(1).describe('Per-device connection resolver key'),
  /** The operator-supplied UDP connection settings the device's client dials. */
  connection: greeConfigSchema,
  system: z.literal('gree').optional(),
  integrationId: z.string().optional(),
  name: z.string().optional(),
})

export type GreeAcDeviceConfig = z.infer<typeof greeAcDeviceSchema>

/**
 * Hand-written connection form for the AC device-creation UI (standalone mode —
 * Reolink pattern). The connection lives on the AC DEVICE config, not in a broker
 * registry. A `name` field is included so the operator names the AC at creation
 * time (mirrors the Reolink / Ecowitt creation form).
 */
export function buildConnectionFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Air conditioner',
        titleKey: 'provider-gree:connection.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-gree:connection.s_identity.name.label',
            required: true,
            placeholder: 'Living room AC',
          },
          {
            type: 'text',
            key: 'host',
            label: 'IP address',
            labelKey: 'provider-gree:connection.s_identity.host.label',
            required: true,
            placeholder: '192.168.10.50',
          },
        ],
      },
      {
        id: 'advanced',
        title: 'Advanced (UDP)',
        titleKey: 'provider-gree:connection.s_advanced.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'broadcastAddr',
            label: 'Broadcast address (optional)',
            labelKey: 'provider-gree:connection.s_advanced.broadcastAddr.label',
            required: false,
            placeholder: '192.168.10.255',
          },
          {
            type: 'number',
            key: 'timeoutMs',
            label: 'UDP timeout (ms)',
            labelKey: 'provider-gree:connection.s_advanced.timeoutMs.label',
            min: 500,
            max: 30_000,
            default: 3_000,
          },
          {
            type: 'number',
            key: 'retries',
            label: 'Retries',
            labelKey: 'provider-gree:connection.s_advanced.retries.label',
            min: 0,
            max: 10,
            default: 3,
          },
          {
            type: 'select',
            key: 'encryption',
            label: 'Encryption',
            labelKey: 'provider-gree:connection.s_advanced.encryption.label',
            default: 'auto',
            options: GREE_ENCRYPTION_MODES.map((m) => ({ value: m, label: m.toUpperCase() })),
          },
        ],
      },
    ],
  }
}

/**
 * Extra params form for a PER-INTEGRATION network scan. Gree's UDP broadcast
 * only reaches the addon node's local subnet; to find ACs on a DIFFERENT subnet
 * (e.g. 192.168.20.x) the operator supplies that subnet's directed-broadcast
 * address (192.168.20.255). Empty = default local-subnet broadcast.
 */
export function buildDiscoveryParamsFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'scan',
        title: 'Scan options',
        titleKey: 'provider-gree:discoveryParams.s_scan.title',
        description:
          'Leave empty to scan the local subnet; for another subnet enter its broadcast address (e.g. 192.168.20.255).',
        descriptionKey: 'provider-gree:discoveryParams.s_scan.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'broadcastAddress',
            label: 'Broadcast address',
            labelKey: 'provider-gree:discoveryParams.s_scan.broadcastAddress.label',
            required: false,
            placeholder: '192.168.20.255',
          },
          {
            type: 'number',
            key: 'timeoutMs',
            label: 'UDP timeout (ms)',
            labelKey: 'provider-gree:discoveryParams.s_scan.timeoutMs.label',
            min: 500,
            max: 30_000,
            default: 3_000,
          },
        ],
      },
    ],
  }
}
