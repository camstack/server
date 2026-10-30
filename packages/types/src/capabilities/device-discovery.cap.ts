import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  type InferNativeProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { SourceInfoSchema } from '../device/source-info.js'
import type { SourceInfo } from '../device/source-info.js'

/**
 * device-discovery — device-scoped capability for parents that host /
 * enumerate child devices (Reolink Hub / NVR, ONVIF gateway, future
 * integrations). The parent advertises a list of discoverable children,
 * and the operator promotes a subset to real devices via `adoptDevice`.
 * Child lifecycle (kernel device create/remove, parent reference) is
 * owned by the framework so a single shared `<DiscoveryPanel />` can
 * drive any integration.
 *
 * Boundaries:
 *   - The cap exposes ENUMERATION + ADOPT/RELEASE only. The protocol
 *     used to discover children (CGI poll, mDNS, push from hub, ...)
 *     is the integration's business; results land in `runtimeState`
 *     so the panel can render without a fresh round-trip.
 *   - `childNativeId` is integration-defined and must be stable across
 *     reboots so re-discovery doesn't duplicate adopted children.
 *   - `adoptDevice` returns the new `deviceId` so the UI can navigate
 *     directly to the freshly-created child's settings page.
 */

/**
 * Status enum for a discovered device. Mirrors the Reolink simpleEvent
 * lifecycle (`online` / `sleeping` / `offline`) — generic enough for
 * battery cams, awake cams, and unreachable cams alike.
 */
export const DiscoveredChildStatusSchema = z.enum(['online', 'sleeping', 'offline', 'unknown'])
export type DiscoveredChildStatus = z.infer<typeof DiscoveredChildStatusSchema>

/**
 * Explicit type for the (now self-referential) discovered-child entry.
 * A `z.lazy` schema cannot cleanly self-infer, so the shape is declared
 * here and the schema below is annotated with it. The `children` /
 * `sourceInfo` / `capabilities` / `features` fields are optional: Hubs
 * (Reolink NVR enumerating flat camera channels) omit them entirely;
 * integrations (Home Assistant previewing a device with entity-children)
 * populate them so a shared adoption panel can render an accordion.
 */
export type DiscoveredChildDevice = {
  childNativeId: string
  name: string
  type: DeviceType
  status: DiscoveredChildStatus
  metadata: {
    model?: string
    serialNumber?: string
    uid?: string
    rtspChannel?: number
    isBattery?: boolean
    isDoorbell?: boolean
    isMultifocal?: boolean
    externalLocation?: string
    manufacturer?: string
    integration?: string
  }
  alreadyAdopted: boolean
  adoptedDeviceId: number | null
  // ── Shared adoption fields (optional; Hubs omit, integrations populate) ──
  capabilities?: readonly string[]
  features?: readonly string[]
  sourceInfo?: SourceInfo
  children?: readonly DiscoveredChildDevice[]
  /** `childNativeId` of the gateway candidate (in the same list) this device sits behind. */
  parentStableId?: string
}

export const DiscoveredChildDeviceSchema: z.ZodType<DiscoveredChildDevice> = z.lazy(() =>
  z.object({
    /** Stable, integration-defined identifier. Must be unique per parent and persistent across reboots. */
    childNativeId: z.string(),
    /** Friendly name as reported by the source (Reolink camera name, ONVIF profile, ...). */
    name: z.string(),
    /** DeviceType the child should be created with on adopt. */
    type: z.enum(DeviceType),
    status: DiscoveredChildStatusSchema,
    /** Free-form integration-specific metadata surfaced in the panel. */
    metadata: z
      .object({
        model: z.string().optional(),
        serialNumber: z.string().optional(),
        uid: z.string().optional(),
        /** Reolink: 0-based channel index inside the parent NVR/Hub. */
        rtspChannel: z.number().int().nonnegative().optional(),
        isBattery: z.boolean().optional(),
        isDoorbell: z.boolean().optional(),
        isMultifocal: z.boolean().optional(),
        externalLocation: z.string().optional(),
        /** Vendor / manufacturer name as reported by the source (HA device
         *  `manufacturer`, …). Surfaced in the adoption modal's fuzzy search. */
        manufacturer: z.string().optional(),
        /** Integration / platform domain the candidate belongs to (HA
         *  `entity_registry.platform`, e.g. `dreame_vacuum`). Surfaced in the
         *  adoption modal's fuzzy search. */
        integration: z.string().optional(),
      })
      .default({}),
    /**
     * `true` when the framework already created a child device for this
     * `childNativeId` under the current parent. The panel uses it to
     * gate the Add/Remove button and surface the existing `deviceId`.
     */
    alreadyAdopted: z.boolean(),
    /** When `alreadyAdopted=true`, the framework-assigned child device id. */
    adoptedDeviceId: z.number().int().nonnegative().nullable(),
    /** Capability names the candidate advertises — integrations populate, Hubs omit. */
    capabilities: z.array(z.string()).readonly().optional(),
    /** Feature flags the candidate advertises — integrations populate, Hubs omit. */
    features: z.array(z.string()).readonly().optional(),
    /** Upstream-system identity + rendering hints for the candidate. */
    sourceInfo: SourceInfoSchema.optional(),
    /** Nested entity-children for accordion preview — integrations populate, Hubs omit. */
    children: z.array(DiscoveredChildDeviceSchema).readonly().optional(),
    /** `childNativeId` of the gateway candidate in the same list this device sits behind. */
    parentStableId: z.string().optional(),
  }),
)

/**
 * Status block — populated by the integration after each
 * `refreshDiscovery` (or push-driven update). The runtime-state slice
 * is what the panel reads via the per-device proxy; `getStatus`
 * returns the same payload via the codegen'd auto-injection.
 */
export const DeviceDiscoveryStatusSchema = z.object({
  discovered: z.array(DiscoveredChildDeviceSchema),
  /** Wall-clock ms of the last successful enumeration. */
  lastDiscoveryAt: z.number().int().nonnegative().nullable(),
  /** Last error surfaced from the source (rendered as a banner). */
  lastError: z.string().nullable(),
})
export type DeviceDiscoveryStatus = z.infer<typeof DeviceDiscoveryStatusSchema>

export const deviceDiscoveryCapability = {
  name: 'device-discovery',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Hub is the canonical parent. Other integrations (gateway-style)
  // can register against the cap by also targeting their root type.
  deviceTypes: [DeviceType.Hub],
  status: {
    schema: DeviceDiscoveryStatusSchema,
    kind: 'poll',
  },
  // Mirror status into the per-device runtime-state slice so the panel
  // hydrates from the kernel cache without a round-trip on every open.
  runtimeState: DeviceDiscoveryStatusSchema.extend({
    lastFetchedAt: z.number().int().nonnegative(),
  }),

  /**
   * Runtime-state durability: **session** — 5.7 KB of scan output on the largest device, fully re-derivable by re-scanning.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — inventory.
   */
  history: 'none',
  methods: {
    /**
     * Snapshot of the current `discovered` list. Returns the
     * runtime-state cache — call `refreshDiscovery` first if a
     * fresh round-trip to the source is required.
     */
    listDiscovered: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(DiscoveredChildDeviceSchema).readonly(),
    ),
    /**
     * Force the integration to re-enumerate and update the
     * runtime-state slice. Returns the freshly-enumerated list (also
     * available via `listDiscovered` post-call).
     */
    refreshDiscovery: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(DiscoveredChildDeviceSchema).readonly(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Promote a discovered entry to a real child device. The framework
     * creates the child via `kernel.devices.create()` with
     * `parentDeviceId = parent.id` and seeds the child's config from
     * `childInitialConfig` (driver-defined; usually carries channel +
     * uid + parent reference). Returns the kernel-assigned numeric id.
     */
    adoptDevice: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        childNativeId: z.string(),
        /** Optional override for the child's display name. */
        name: z.string().optional(),
      }),
      z.object({
        deviceId: z.number().int().nonnegative(),
        stableId: z.string(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Inverse of `adoptDevice`: removes the child device from the
     * kernel registry. The discovered entry remains in the
     * enumeration (status updates resume) so the operator can re-adopt
     * it later without a fresh refresh.
     */
    releaseDevice: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        childDeviceId: z.number().int().nonnegative(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceDiscoveryProvider = InferProvider<typeof deviceDiscoveryCapability>
export type IDeviceDiscoveryNativeProvider = InferNativeProvider<typeof deviceDiscoveryCapability>
