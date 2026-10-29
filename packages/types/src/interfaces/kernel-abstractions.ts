/**
 * Minimal interfaces for kernel services consumed by @camstack/system.
 *
 * These abstractions break the direct core -> kernel import dependency,
 * allowing core to depend only on @camstack/types while kernel provides
 * the concrete implementations.
 */
import type { AddonDeclaration } from './addon.js'
import type { FrameInput } from '../types/io.js'
import type { CropInput } from '../types/detection.js'
import type { InferenceOutput } from './pipeline-runner.js'
import type { CapabilityProviderMap } from './capability.js'
import type { DeviceCall, DeviceCallAnswer, DeviceCallRedirect } from './device-call-redirect.js'
import type { StatusOverlay, StatusOverlayAnswer } from './status-overlay.js'

// ---------------------------------------------------------------------------
// ICapabilityRegistry — used by NotificationService
// ---------------------------------------------------------------------------

/**
 * Capability registry interface exposing what core/addon consumers need.
 * The full CapabilityRegistry in @camstack/system implements this and more.
 */
export interface ICapabilityRegistry {
  /** Get all active collection providers for a capability. */
  getCollection<T = unknown>(capability: string): readonly T[]
  /**
   * Wait for a provider of `capabilityName` registered by `addonId`.
   *
   * The typed overload narrows the result to the provider interface mapped in
   * `CapabilityProviderMap` (e.g. `'device-adoption'` → `IDeviceAdoptionProvider`)
   * so callers need no cast; the string overload preserves the loose contract
   * for dynamic capability names.
   */
  waitForProvider<K extends keyof CapabilityProviderMap>(
    capabilityName: K,
    addonId: string,
    timeoutMs: number,
  ): Promise<CapabilityProviderMap[K] | null>
  waitForProvider(
    capabilityName: string,
    addonId: string,
    timeoutMs: number,
  ): Promise<unknown | null>
  /** Get the singleton provider for a system capability. */
  getSingleton<T = unknown>(capabilityName: string): T | null
  /** Get the native provider for a (cap, device) pair. */
  getNativeProvider<T = unknown>(capName: string, deviceId: number): T | null
  /**
   * Unified per-device resolver (D13) — native first, then a device-bound
   * system provider. Consumers use this instead of branching between
   * `getNativeProvider` and `getProviderByAddon`.
   */
  getProviderForDevice<T = unknown>(capName: string, deviceId: number): T | null
  /**
   * Install (or remove, with `null`) the claimed-status overlay (D663, S3).
   * While installed, `getNativeProvider` / `getProviderForDevice` answer
   * `getStatus` of a CLAIMED `(cap, device)` from it; every other method is
   * the provider's own. The device-manager installs it over its mirror.
   */
  setStatusOverlay(overlay: StatusOverlay | null): void
  /**
   * The one question every resolution of a device-scoped `getStatus` awaits
   * before answering: resolves the device's claims first (index, then its row,
   * single-flight) and answers `claimed` / `unclaimed`; `unknown` only when the
   * row cannot be read — and then the answer is "not reported", never the
   * native (D315, D49).
   */
  resolveClaimedStatus(capName: string, deviceId: number): Promise<StatusOverlayAnswer>
  /**
   * Install (or remove, with `null`) the device-call redirect (D963). While
   * installed, a covered device-scoped call resolved through the registry —
   * and, through `redirectDeviceCall`, through the transport entries — may be
   * taken over before it reaches the provider.
   */
  setDeviceCallRedirect(redirect: DeviceCallRedirect | null): void
  /** Cheap and synchronous: could a redirect take this `(cap, method)` over? Asked before args are decoded. */
  coversDeviceCall(capName: string, method: string): boolean
  /** The one question every name-resolving entry asks before routing. */
  redirectDeviceCall(call: DeviceCall): Promise<DeviceCallAnswer>
  /** Get the addonId that registered a native provider for (cap, device). */
  getNativeAddonId(capName: string, deviceId: number): string | null
  /** List all capability names with a native registration for a device. */
  getNativeCapsForDevice(deviceId: number): readonly string[]
  /** List addon ids that declared a wrapper provider for a capability. */
  getWrappersForCap(capName: string): readonly string[]
  /** Return the wrapper addon flagged `defaultActive: true` for a capability, or null. */
  getDefaultWrapperForCap(capName: string): string | null
  /** List capability names that have at least one wrapper flagged `defaultActive: true`. */
  getCapsWithDefaultWrapper(): readonly string[]
  /** Remove all native-provider registrations for a device (used on device removal). */
  unregisterAllNativeForDevice(deviceId: number): void
  /** Get the capability definition for a declared capability. */
  getDefinition(
    capability: string,
  ): import('../capabilities/capability-definition.js').CapabilityDefinition | undefined
  /** Get a specific provider by addon id. */
  getProviderByAddon<T = unknown>(capabilityName: string, addonId: string): T | null
  /** List all declared capabilities with their provider info. */
  listCapabilities(): ReadonlyArray<{
    name: string
    mode: string
    providers: readonly string[]
    activeProvider: string | null
  }>
  /** List device-scoped capability names that apply to a device type. */
  listDeviceScopedCapsForType(deviceType: string): readonly string[]
}

// ---------------------------------------------------------------------------
// IEngineInstance — addon engine with typed process/classifyAudio methods
// ---------------------------------------------------------------------------

/** An engine instance returned by IEngineManager — typed interface instead of raw ICamstackAddon */
export interface IEngineInstance {
  /** Run inference on a frame or crop */
  process(input: FrameInput | CropInput): Promise<InferenceOutput>
  /** Classify audio (optional — only audio addons) */
  classifyAudio?(input: unknown): Promise<unknown>
}

// ---------------------------------------------------------------------------
// IEngineManager — used by PipelineRunner
// ---------------------------------------------------------------------------

/**
 * Minimal engine manager interface for creating/reusing addon engine instances.
 */
export interface IEngineManager {
  /**
   * Get or create an addon engine for the given effective config.
   * Cameras with the same addonId + effective config share the same engine.
   */
  getOrCreateEngine(
    addonId: string,
    globalConfig: Record<string, unknown>,
    cameraOverride?: Record<string, unknown>,
  ): Promise<IEngineInstance>
  /** Shutdown all managed engine instances */
  shutdownAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// IAddonLoader — used by PipelineValidator
// ---------------------------------------------------------------------------

/** Subset of RegisteredAddon exposed through the interface. */
export interface IRegisteredAddon {
  readonly declaration: AddonDeclaration
}

/**
 * Minimal addon loader interface for querying registered addons.
 */
export interface IAddonLoader {
  /** Check if an addon is registered */
  hasAddon(addonId: string): boolean
  /** Get a registered addon by ID */
  getAddon(addonId: string): IRegisteredAddon | undefined
}
