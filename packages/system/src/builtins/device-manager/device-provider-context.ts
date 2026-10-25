/**
 * Shared dependency context for the device-manager provider-method modules
 * (`device-meta-actions`, `device-queries`). The `IDeviceManagerProvider`
 * implementation was a single ~1800-line object literal closing over
 * `onInitialize` locals AND the addon `this`. Splitting it into focused modules
 * requires an explicit context (DI) instead of those captures.
 *
 * `ProviderHost` is the narrow slice of the addon instance the extracted
 * functions reach (mostly private fields exposed through a host object the
 * addon builds). `ProviderContext` bundles that host with the meta store, the
 * settings surface, the hub registry, and the two shared closures
 * (`requireDeviceOps`, `stampIntegrationId`). Behavior is unchanged — the
 * functions read/write exactly the same state the closures did.
 */
import type {
  AddonContext,
  ICapabilityRegistry,
  IDeviceAdoptionProvider,
  IDeviceManagerProvider,
  IDeviceOpsProvider,
  IDeviceRegistry,
  InferProvider,
} from '@camstack/types'
import { deviceProviderCapability } from '@camstack/types'
import type { AdoptionJobEngine } from './adoption-job-engine.js'
import type { BindingsDeps } from './device-bindings-store.js'
import type { DeviceManagerSettings, DeviceMetaStore } from './device-meta-store.js'
import type { FieldClaimsIndex } from './field-claims-index.js'
import type { OwnedCaps } from './field-ownership.js'
import type { MigrationGuard } from './migrate-guard.js'
import type { DeviceTombstoneStore } from './device-tombstone-store.js'
import type { RemovalHookDeps } from './device-removal-hooks.js'
import type { RemovalCleanup } from './removal-cleanup.js'
import type { RemovalFence } from './removal-fence.js'
import type { SecretConfigPathRegistry } from './secret-config-paths.js'
import type { SeedMode } from './device-state-mirror.js'
import type { MirrorWriteHold } from './mirror-row-writer.js'

type IDeviceProviderCap = InferProvider<typeof deviceProviderCapability>

/**
 * The addon-instance surface the extracted provider functions need. Exposed by
 * the addon as a host object so the functions never capture `this` directly and
 * the addon stays the sole owner of its private state.
 */
export interface ProviderHost {
  readonly ctx: AddonContext
  readonly capabilityRegistry: ICapabilityRegistry | undefined
  /** Push-fed remote native-cap cache (numeric deviceId → capName → owner). */
  readonly remoteNativeCaps: Map<number, Map<string, { addonId: string; nodeId: string }>>
  /**
   * Seed the runtime-state mirror for a device (no events). `fill` (the boot
   * path) only fills caps memory lacks; `replace` (the migration reseed) makes
   * the mirror answer exactly this blob — the row now belongs to different
   * hardware, so whatever memory held is the wrong device's state (D663).
   */
  seedMirror(deviceId: number, blob: Record<string, unknown>, mode?: SeedMode): void
  /**
   * Drain the mirror's debounced writer on these devices and hold it off their
   * rows until `release` — a migration swapping the rows must not race a write
   * that read the pre-swap hardware's blob (D663).
   */
  holdMirrorWrites(
    deviceIds: readonly number[],
    settings: DeviceManagerSettings,
  ): Promise<MirrorWriteHold>
  /**
   * The claims the mirror holds for a device — accepted ones included, whose
   * write-through may not have landed yet. A migration's second look (D663).
   */
  mirrorOwnedCaps(deviceId: number): OwnedCaps
  /**
   * Forget a REMOVED device in the mirror: cancel its armed row write, await
   * one in flight, drop its slices, claims and baseline (D677). Called before
   * the row is cleared, so no write lands an orphan row after it.
   */
  forgetMirrorDevice(deviceId: number): Promise<void>
  /** Reset a stale per-session `feature-probe` timestamp before mirror seeding. */
  withResetSessionProbe(blob: Record<string, unknown>): Record<string, unknown>
  /** The per-field claims index (D663) — `removeDevice` prunes a removed device from it. */
  readonly fieldClaims: FieldClaimsIndex
  /** Resolve a device's real `online` flag from the mirrored device-status slice. */
  resolveDeviceOnline(deviceId: number, fallbackOnline: boolean): boolean
  /** Resolve a device's `probed` flag from the mirrored feature-probe slice. */
  resolveDeviceProbed(deviceId: number): boolean
  /** Wait for a device-provider by addonId, returning null on timeout. */
  waitDeviceProvider(addonId: string, timeoutMs?: number): Promise<IDeviceProviderCap | null>
  /** Require a device-provider by addonId — throws if not found. */
  requireDeviceProvider(addonId: string): Promise<IDeviceProviderCap>
  /** Require a device-adoption provider by addonId — throws if not found. */
  requireDeviceAdoptionProvider(addonId: string): Promise<IDeviceAdoptionProvider>
  /** Background adoption jobs — the deadline-free form of `adoptionAdopt`. */
  readonly adoptionJobs: AdoptionJobEngine
}

/**
 * Full context the provider-method modules consume. `provider` is a lazy getter
 * for the assembled `IDeviceManagerProvider` so the few methods that self-call
 * sibling cap methods (e.g. `remove` → `removeDevice`, `removeByIntegration` →
 * `remove`, `enable`/`disable` → `setDisabled`) resolve the live implementation
 * without a capture cycle at construction time.
 */
export interface ProviderContext {
  readonly host: ProviderHost
  readonly metaStore: DeviceMetaStore
  readonly settings: DeviceManagerSettings
  /** Hub-process device registry (null when this node owns no registry). */
  readonly registry: IDeviceRegistry | null
  readonly bindingsDeps: BindingsDeps
  /** In-flight refusal + completed-swap replay for `migrateDevice` — the
   *  reason a retried migration can no longer undo the one that ran. */
  readonly migrationGuard: MigrationGuard
  /** Keeps a removed device removed: refuses the `registerDevice` /
   *  `allocateDeviceId` that a still-live device object issues as its runner
   *  tears down, which is how a deleted camera came back as a config-less
   *  shell (D376). */
  readonly removalFence: RemovalFence
  /** Cleans a removed device's data store by store, bounded retry on failure (D864). */
  readonly removalCleanup: RemovalCleanup
  /** The tombstone of every deleted device — the reliable record other addons reconcile from (D865). */
  readonly tombstones: DeviceTombstoneStore
  /** Tells every `device-removal-hook` implementer a device was deleted (D865). */
  readonly removalHooks: RemovalHookDeps
  /** The secret config paths each device declared at `registerDevice` (D783). */
  readonly secretConfigPaths: SecretConfigPathRegistry
  /** Resolve the per-device `device-ops` native provider (throws when absent). */
  requireDeviceOps(deviceId: number): IDeviceOpsProvider
  /** Stamp an integration id onto a device's meta row + emit DeviceMetaChanged. */
  stampIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** The assembled `IDeviceManagerProvider`, resolved lazily so the few methods
   *  that self-call sibling cap methods (`remove` → `removeDevice`,
   *  `removeByIntegration` → `remove`, `enable`/`disable` → `setDisabled`,
   *  `probeStreams`/`getStreamProfileMap` → `getStreamSources`) reach the live
   *  implementation without a construction-time capture cycle. */
  readonly provider: IDeviceManagerProvider
}
