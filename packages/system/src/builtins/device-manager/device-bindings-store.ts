/**
 * Persisted wrapper-activation + per-device binding resolution for the
 * device-manager addon. Extracted from `device-manager.addon.ts` as free
 * functions that receive an explicit `BindingsDeps` context (dependency
 * injection) instead of closing over the addon instance — keeps the routing
 * logic cohesive and independently testable while preserving the EXACT call
 * semantics, ordering, and side effects of the original class methods.
 *
 * The addon keeps thin delegator methods (`getBindings`, `getAllBindings`, …)
 * that build `BindingsDeps` from its own state and forward here, so every
 * existing internal + cap-router call site is unchanged.
 */

import type {
  AddonContext,
  CapabilityDefinition,
  DeviceBindingEntry,
  ICapabilityRegistry,
} from '@camstack/types'
import { COMPOSER_ADDON_ID, EventCategory } from '@camstack/types'
import type { DeviceBindingsStore } from './device-meta-types.js'
import type { DeviceRow, DeviceRowStore } from './device-row-store.js'
import type { StaleWrapperActivations } from './stale-wrapper-activations.js'
import { isDeclaredCollectionCap, isRetiredWrapperActivation } from './stale-wrapper-activations.js'
import type { WriteLock } from './write-lock.js'

/** Push-fed remote native-cap cache shape (numeric deviceId → capName → owner). */
export type RemoteNativeCaps = Map<number, Map<string, { addonId: string; nodeId: string }>>

/**
 * Low-level dependencies the binding resolver needs. Assembled by the addon
 * from its own (mostly private) state and passed in explicitly — no hidden
 * `this` capture.
 */
export interface BindingsDeps {
  readonly ctx: AddonContext
  readonly capabilityRegistry: ICapabilityRegistry | undefined
  readonly remoteNativeCaps: RemoteNativeCaps
  /** Row access for `device-manager:devices` — the device ledger the type and
   *  presence gates below consult. */
  readonly rows: DeviceRowStore
  /**
   * Ordering for every read-modify-write of this addon's `addon-settings` key
   * range — `deviceBindings` above all, but also `locations`, `nextDeviceId`
   * and `roleDisplayDefaults`.
   *
   * `deviceBindings` is ONE fleet-wide blob keyed by device, so a writer that
   * only means to touch camera 101 rewrites every camera's row. Nothing
   * ordered those writers, and the window between the read and the write is a
   * settings-door round trip — an RPC to the isolated `sqlite-settings` child,
   * measured at 2.9 s on the live hub mid-drain (D181). Two toggles on
   * DIFFERENT cameras therefore lost each other, and the value that went
   * missing was `{ wrapperAddonId: null }`: the marker that keeps a
   * `defaultActive` wrapper from re-binding. The operator's OFF came back ON
   * (D62).
   *
   * **Writers only.** No read path takes this lock: `getBindings`,
   * `getBindingsBatch` and `getAllBindings` must never queue behind a write,
   * and putting a read under it would make a 1 019-device sweep wait on
   * whatever toggle happens to be in flight.
   */
  readonly withAddonStoreWriteLock: WriteLock
  /**
   * The per-process memory of stored activations that name a RETIRED wrapper
   * (a cap with no `kind: 'wrapper'` any more): each is ignored by step 1 and
   * said once (task 17 review M1, `stale-wrapper-activations.ts`).
   */
  readonly staleWrapperActivations: StaleWrapperActivations
}

/**
 * Wire the push-fed cross-process native-cap cache (`remoteNativeCaps`).
 * Workers emit `DeviceBindingsChanged` on `ctx.registerNativeCap` / device
 * removal; we mirror those into `remoteNativeCaps` so `getBindings` returns the
 * full cluster view. Events from the local node are ignored: hub-local natives
 * live in `capabilityRegistry` and are folded in directly by getBindings.
 *
 * Push events are accurate in the steady state but can be lost during the
 * Moleculer transport handshake window (hub restart, crash-respawn,
 * restartAddon). The reliable replacement for lost events is the D3 re-handshake
 * (`listClusterNativeCaps()`), which `resolveNativeCapOwnerSync` /
 * `getBindings` step 4 fall through to on a push miss. The `$node.disconnected`
 * handler purges a gone node's entries; the worker re-handshakes (and re-emits
 * `native-registered`) on its next boot.
 */
export function wireRemoteNativeCapSync(
  ctx: AddonContext,
  remoteNativeCaps: RemoteNativeCaps,
): void {
  const localNodeId = ctx.kernel.localNodeId ?? 'hub'
  ctx.eventBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (event) => {
    const { deviceId, capName, reason, addonId, nodeId } = event.data
    if (nodeId === localNodeId) return
    if (reason === 'native-registered') {
      let perDevice = remoteNativeCaps.get(deviceId)
      if (!perDevice) {
        perDevice = new Map()
        remoteNativeCaps.set(deviceId, perDevice)
      }
      // Native always wins (D663, I-2): a composer GRAFT never overwrites another
      // addon's native for the same (device, cap). The reverse is a normal
      // overwrite — the composer hears that registration and ungrafts.
      const existing = perDevice.get(capName)
      if (
        addonId === COMPOSER_ADDON_ID &&
        existing !== undefined &&
        existing.addonId !== COMPOSER_ADDON_ID
      ) {
        ctx.logger.warn('a graft did not replace a native binding — native always wins', {
          tags: { deviceId },
          meta: { capName, native: existing.addonId, nodeId },
        })
        return
      }
      perDevice.set(capName, { addonId, nodeId })
    } else if (reason === 'native-unregistered') {
      const perDevice = remoteNativeCaps.get(deviceId)
      if (!perDevice) return
      // Only the addon that registered this (device, cap) retracts it (D663):
      // the composer's ungraft must never erase a native that appeared since,
      // nor a native's restart erase a graft. Both event kinds carry the
      // registering addon's own id. A node leaving still purges everything.
      if (perDevice.get(capName)?.addonId !== addonId) return
      perDevice.delete(capName)
      if (perDevice.size === 0) remoteNativeCaps.delete(deviceId)
    }
  })

  const cluster = ctx.kernel.cluster
  if (cluster) {
    cluster.broker.localBus.on('$node.disconnected', (payload) => {
      const gone = payload.node.id
      const emptyDevices: number[] = []
      for (const [deviceId, perDevice] of remoteNativeCaps) {
        const toDelete: string[] = []
        for (const [capName, entry] of perDevice) {
          if (entry.nodeId === gone) toDelete.push(capName)
        }
        for (const capName of toDelete) perDevice.delete(capName)
        if (perDevice.size === 0) emptyDevices.push(deviceId)
      }
      for (const deviceId of emptyDevices) remoteNativeCaps.delete(deviceId)
    })
  }
}

/**
 * All a bindings-store read or write needs: the settings door. Named narrower
 * than {@link BindingsDeps} so the activation verb (`device-source-activation.ts`)
 * can reach the store without the device ledger and the remote-native cache it
 * never touches — `BindingsDeps` satisfies it structurally, so every existing
 * call site is unchanged.
 */
export interface BindingsStoreDeps {
  readonly ctx: AddonContext
}

export async function readBindingsStore(deps: BindingsStoreDeps): Promise<DeviceBindingsStore> {
  const raw = (await deps.ctx.settings!.readAddonStore()) as Partial<DeviceBindingsStore>
  return { deviceBindings: raw.deviceBindings ?? {} }
}

export async function writeBindingsStore(
  deps: BindingsStoreDeps,
  next: DeviceBindingsStore,
): Promise<void> {
  await deps.ctx.settings!.writeAddonStore({ deviceBindings: next.deviceBindings })
}

export function resolveWrapperNodeId(_wrapperAddonId: string): string {
  // TODO(phase-7): read from cluster view so cluster-deployed wrappers
  // report their actual node. For now assume hub-co-located.
  return 'hub'
}

/**
 * Reduce a provider node id to the routable form `DeviceProxy` can pin.
 *
 * Every addon runs in its own `addon-runner` with the composite node id
 * `${parentNodeId}/${runnerId}` (see `addon-runner.ts`) — e.g.
 * `hub/provider-reolink` or `dev-agent-0/provider-reolink`. That composite is
 * an IDENTITY, not a routable target: the `CapRouteResolver` reaches a child
 * only THROUGH its parent (the hub resolves a hub-local-uds child by
 * cap+device; an agent forwards to its own child). `DeviceProxy` pins
 * `entry.providerNodeId` on every cap call, so a binding entry must expose the
 * parent node id — otherwise the explicit pin classifies as `remote-moleculer`
 * to an unknown node → `no-provider`, which surfaces as
 * "this camera doesn't expose …" for client-proxy-driven widget caps
 * (motion-zones, privacy-mask). Wrappers already report the parent via
 * `resolveWrapperNodeId`; this aligns natives with the same contract.
 *
 * A flat node id (a genuine standalone node with no `/`) is returned
 * unchanged.
 */
export function toRoutableProviderNodeId(nodeId: string): string {
  const slash = nodeId.indexOf('/')
  return slash === -1 ? nodeId : nodeId.slice(0, slash)
}

/**
 * Resolve a remote native cap entry for a given `(capName, deviceId)` by
 * consulting the handshake-fed `HubNodeRegistry` via
 * `ctx.kernel.listClusterNativeCaps()`. Called when the push-based
 * `remoteNativeCaps` cache misses — covers the Moleculer transport
 * handshake window where `DeviceBindingsChanged` events were lost but the
 * D3 re-handshake (post device restore) has already populated the registry.
 *
 * Returns `null` when the entry is genuinely not present in the cluster
 * view (cap not registered on any worker for that device).
 */
export function resolveRemoteNativeCapFromRegistry(
  deps: BindingsDeps,
  capName: string,
  deviceId: number,
): { addonId: string; nodeId: string } | null {
  // Prefer the O(caps-for-device) indexed lookup; fall back to the
  // whole-cluster flat view when the host doesn't expose it.
  const clusterCaps =
    deps.ctx.kernel.listClusterNativeCapsForDevice?.(deviceId) ??
    deps.ctx.kernel.listClusterNativeCaps?.()
  if (!clusterCaps) return null
  // Hub-local natives are NOT in the cluster registry (they live in
  // `capabilityRegistry`) — the caller already checked those.
  // Filter to the first remote entry matching (capName, deviceId).
  for (const entry of clusterCaps) {
    if (entry.capName === capName && entry.deviceId === deviceId && entry.addonId) {
      return { addonId: entry.addonId, nodeId: entry.nodeId }
    }
  }
  return null
}

/**
 * Resolve the device's declared TYPE (`'camera'`, `'event-emitter'`, …), or
 * `undefined` when it cannot be established.
 *
 * The PERSISTED row is the authority: `ctx.kernel.deviceRegistry` is hub-only
 * and has been observed empty in the very process that answers `getBindings`
 * correctly (see the note on `getAllBindings`). The registry is consulted only
 * as a secondary source, for a device constructed but not yet persisted.
 *
 * `undefined` is a first-class answer and callers must treat it as "no
 * filtering" — an absent row must never be the reason a device loses bindings.
 */
export function resolveDeviceType(
  deps: BindingsDeps,
  row: DeviceRow | null,
  deviceId: number,
): string | undefined {
  const persisted = row?.meta.type
  if (typeof persisted === 'string' && persisted.length > 0) return persisted
  const live = deps.ctx.kernel?.deviceRegistry?.getById(deviceId)?.type
  return typeof live === 'string' && live.length > 0 ? live : undefined
}

/**
 * Whether the device-manager's own stores still know a device id.
 *
 * `'unknown'` is NOT `'absent'` — it means the question could not be answered
 * and the caller must behave exactly as it did before asking.
 */
export type DevicePresence = 'present' | 'absent' | 'unknown'

/**
 * Is this device still part of the fleet?
 *
 * The device-manager's own stores are the authority in-process — no RPC. Two
 * sources, in the same order `resolveDeviceType` uses them: the live registry
 * first (a device constructed but not yet persisted is present), then the
 * PERSISTED meta, which is the index `getBindings` already reads and is present
 * wherever this provider runs.
 *
 * `'absent'` is only ever returned against a NON-EMPTY ledger. An empty one
 * means device restore has not run, not that the fleet was deleted (D49) — the
 * same reason `getAllBindings` warns instead of reporting zero devices. That is
 * the only reason this is async: the `COUNT(*)` runs solely on the miss path,
 * where the alternative is to call a device gone because the store is empty.
 *
 * `ledgerNonEmpty` is passed IN rather than defaulted, deliberately. A default
 * that issued its own `rows.count()` would be a per-device read hiding behind
 * an optional argument — the exact shape this file just removed from the
 * activations blob — and nothing would fail when a future caller took it.
 */
export async function resolveDevicePresence(
  deps: BindingsDeps,
  row: DeviceRow | null,
  deviceId: number,
  ledgerNonEmpty: LedgerNonEmpty,
): Promise<DevicePresence> {
  if (deps.ctx.kernel?.deviceRegistry?.getById(deviceId)) return 'present'
  if (row !== null) return 'present'
  return (await ledgerNonEmpty()) ? 'absent' : 'unknown'
}

/** "Does the ledger hold any row at all?", asked at most once per pass. */
export type LedgerNonEmpty = () => Promise<boolean>

/**
 * The fleet-wide inputs of a binding resolution, read ONCE for the whole pass.
 *
 * Everything here answers the same question for every device in the pass, so a
 * per-device copy is not a cache miss — it is the same read, repeated. Both
 * fields are settings-store round trips, and on hub-main the settings view is
 * `createDoorSettingsView`: an RPC to the ISOLATED sqlite-settings child.
 * Measured on the live hub 2026-08-30, mid-drain, one such round trip cost
 * 2.9 s. Per device, over 1 019 devices, that is what made `getAllBindings`
 * unanswerable inside `SystemMirror.init`'s 15 s budget — and inside 240 s.
 */
interface BindingsPass {
  /**
   * The persisted wrapper activations. ONE blob for the entire fleet (775
   * bytes on the live hub), keyed by device — so reading it per device also
   * meant every device in a sweep could see a DIFFERENT version of it.
   */
  readonly store: DeviceBindingsStore
  /** See {@link LedgerNonEmpty}. Consulted only on the presence miss path. */
  readonly ledgerNonEmpty: LedgerNonEmpty
}

/**
 * `deps.rows.count()`, collapsed to at most one call per pass.
 *
 * The count answers a FLEET question ("has device restore run at all?"), not a
 * per-device one, and it is reached only when a device misses both the live
 * registry and the ledger. A fleet sweep over a store that is genuinely empty
 * hits that path once per device.
 */
function onceLedgerNonEmpty(deps: BindingsDeps): LedgerNonEmpty {
  let pending: Promise<boolean> | null = null
  return () => {
    if (pending === null) pending = deps.rows.count().then((n) => n > 0)
    return pending
  }
}

/**
 * Does a capability apply to a device of type `deviceType`?
 *
 * The cap's `deviceTypes` is the ONLY declaration consulted (D4: behavioural
 * cap metadata lives in the `*.cap.ts`, never in a manifest). Two deliberate
 * fail-open cases:
 *
 *   - a cap that declares no `deviceTypes` (or an empty list) applies to every
 *     device — the pre-existing, back-compatible semantics;
 *   - an UNKNOWN `deviceType` never filters, so a missing/failed meta lookup
 *     changes nothing (D49: a read that fails must not destroy work).
 */
export function capAppliesToDeviceType(
  def: CapabilityDefinition | undefined,
  deviceType: string | undefined,
): boolean {
  if (deviceType === undefined) return true
  const declared = def?.deviceTypes
  if (!declared || declared.length === 0) return true
  return declared.some((t) => t === deviceType)
}

/**
 * An addon's identity, with the node it happens to run on stripped.
 *
 * A capability registered on an agent arrives under `<addonId>@<nodeId>` —
 * `pipeline-analytics@agent-a`. That is the same ADDON as the hub-local
 * `pipeline-analytics`, and treating the two as different providers is what
 * put `analytics` in device 107's clip picker three times (D554 amended).
 * Where a provider RUNS is a routing fact; it is not part of who it is.
 */
export function addonIdentityOf(addonId: string): string {
  const at = addonId.indexOf('@')
  return at === -1 ? addonId : addonId.slice(0, at)
}

/**
 * Every provider addon of every COLLECTION capability that applies to this
 * device, one entry each.
 *
 * Deduped by {@link addonIdentityOf}, so the hub-local registration, the
 * agent's `<addon>@<node>` one and the device's native registration of the same
 * addon are ONE provider — the defect this exists to make unrepresentable.
 * Gated only by the cap's declared `deviceTypes` (D4), like step 2's auto-bind.
 */
function collectionBindings(
  deps: BindingsDeps,
  deviceId: number,
  deviceType: string | undefined,
): readonly DeviceBindingEntry[] {
  const registry = deps.capabilityRegistry
  if (!registry) return []
  const out: DeviceBindingEntry[] = []
  for (const declared of registry.listCapabilities()) {
    if (declared.mode !== 'collection') continue
    const definition = registry.getDefinition(declared.name)
    if (!capAppliesToDeviceType(definition, deviceType)) continue
    const nativeAddonId = registry.getNativeAddonId(declared.name, deviceId)
    const seen = new Set<string>()
    for (const addonId of [...declared.providers, ...(nativeAddonId ? [nativeAddonId] : [])]) {
      const identity = addonIdentityOf(addonId)
      if (identity.length === 0 || seen.has(identity)) continue
      seen.add(identity)
      out.push({
        capName: declared.name,
        // `kind` is UI metadata and must never be branched on for routing
        // (D13). Every source of a collection cap is reached the same way —
        // by its addon id — so they all report the same shape.
        kind: 'wrapped',
        providerAddonId: identity,
        providerNodeId: resolveWrapperNodeId(identity),
        nativeAddonId: nativeAddonId === null ? '' : addonIdentityOf(nativeAddonId),
      })
    }
  }
  return out
}

export async function getBindings(
  deps: BindingsDeps,
  input: {
    deviceId: number
  },
): Promise<{ deviceId: number; entries: DeviceBindingEntry[] }> {
  // Two settings-store round trips, and they answer INDEPENDENT questions —
  // this device's ledger row, and the fleet-wide wrapper-activation blob.
  // Awaited in series they add up: measured on the live hub 2026-08-30,
  // mid-drain, `getBindings({deviceId:101})` = 5.24 s against 2.87 s for one
  // `settingsStore` read. Nothing orders them, so one device costs one round
  // trip of latency, not two.
  const [row, store] = await Promise.all([deps.rows.get(input.deviceId), readBindingsStore(deps)])
  // The once-per-process retired-wrapper check rides on a store already read.
  deps.staleWrapperActivations.checkStore(store)
  return resolveBindingsForDevice(deps, input.deviceId, row, {
    store,
    ledgerNonEmpty: onceLedgerNonEmpty(deps),
  })
}

/**
 * The `getBindings` resolver, taking the device's row as a PARAMETER instead
 * of fetching it.
 *
 * `getBindings` (one device) and `getBindingsBatch` / `getAllBindings` (many)
 * share this — the routing rules and the per-device shape stay identical by
 * construction. The split exists so the batch callers can resolve every row
 * they need in ONE store round trip ({@link DeviceRowStore.getMany} /
 * {@link DeviceRowStore.listAll}) instead of looping this function's own
 * `deps.rows.get(deviceId)`, which is the primary-key-lookup-per-loop-
 * iteration shape measured on the live hub 2026-08-25: `get
 * device-manager:devices` at 1 656 calls/min steady-state and 17 687 during
 * boot, one row per call.
 *
 * The {@link BindingsPass} is the SECOND half of that same split, and it is
 * the one that was missing. This function used to issue its own
 * `readBindingsStore(deps)` — one settings-door round trip per device, for a
 * blob that is identical for every device in the pass. `getAllBindings` on the
 * live 1 019-device hub therefore cost 1 020 round trips; it never answered
 * inside `SystemMirror.init`'s 15 s budget, and the admin UI refused to boot.
 * Now every entry point resolves the pass once and hands it down — so this
 * function performs NO store reads of its own, and every device in a sweep
 * sees the same version of the activations.
 */
async function resolveBindingsForDevice(
  deps: BindingsDeps,
  deviceId: number,
  row: DeviceRow | null,
  pass: BindingsPass,
): Promise<{ deviceId: number; entries: DeviceBindingEntry[] }> {
  // Every map (bindings store, native-cap registry, remoteNativeCaps) is
  // keyed by numeric deviceId now that Phase 2 finished the migration.
  const storeKey = String(deviceId)
  const perDevice = pass.store.deviceBindings[storeKey] ?? {}
  const deviceType = resolveDeviceType(deps, row, deviceId)
  // "Type unresolved" and "device gone" are different questions and step 2
  // must answer them differently. An unresolved TYPE keeps the fail-open
  // above (it protects a provider restart); an ABSENT device gets no
  // speculative bind at all. Removing a camera deletes its meta row and its
  // persisted activations — after which the auto-bind was re-creating an
  // entry for every `defaultActive` wrapper, so the deleted device came back
  // with each switch the operator had turned OFF silently back ON.
  const presence = await resolveDevicePresence(deps, row, deviceId, pass.ledgerNonEmpty)

  const entries: DeviceBindingEntry[] = []
  const seenCaps = new Set<string>()

  // ── 0. COLLECTION caps, and they are owned here end to end
  //
  // A collection cap's providers are a SET, not a choice between providers,
  // and the set is DERIVED: *"tutti i providers funzionano sempre, non serve
  // disattivarli/attivarli … loro vivono lì"* [all the providers always work, there is no need to deactivate/activate them … they live there] (operator, 2026-09-20). CamStack
  // always, Reolink because it is that camera's provider, HKSV because the
  // camera is exported — none of those is an operator visiting a tick box, so
  // none of them is persisted and there is nothing to migrate onto 300
  // cameras. Steps 1–4 answer ONE entry per cap and are skipped for these,
  // which is why they are marked seen before any of them runs: a persisted
  // `wrapperAddonId` (or its `null` marker) is a singleton's answer and means
  // nothing here.
  //
  // What a provider does with a device it does not serve is the PROVIDER's
  // answer, not this one's: `addon-provider-reolink` lists no sources for a
  // Hikvision camera. The binding says who may be asked.
  const collectionEntries = collectionBindings(deps, deviceId, deviceType)
  for (const entry of collectionEntries) {
    entries.push(entry)
    seenCaps.add(entry.capName)
  }

  // Helper: resolve remote native for (capName, deviceId).
  // Checks the push-fed `remoteNativeCaps` cache first; falls through to
  // the handshake-fed `HubNodeRegistry` (via `listClusterNativeCaps`) for
  // entries lost in the Moleculer transport handshake window.
  const resolveRemote = (capName: string): { addonId: string; nodeId: string } | null =>
    deps.remoteNativeCaps.get(deviceId)?.get(capName) ??
    resolveRemoteNativeCapFromRegistry(deps, capName, deviceId)

  // 1. Entries from persisted wrapper activations
  for (const [capName, { wrapperAddonId }] of Object.entries(perDevice)) {
    // A COLLECTION cap is answered by step 0, from who provides it, and
    // persists nothing (D556): a stored row for one — a retired wrapper's
    // leftover, `device-extension → virtual-doorbell` on camera 101 — is no
    // owner. Judged on the cap's DECLARED mode, not on what step 0 found, so the
    // row stays inert in a boot window or while no provider of it is live (R1-L1).
    if (isDeclaredCollectionCap(capName)) continue
    // A row that carries only `disabledSourceIds` is a COLLECTION cap's
    // source switch (D556) — it says which of several sources the operator
    // turned off, which is not a question `getBindings` can answer (one entry
    // per capName, one `wrapperAddonId`, D554 context 3). It must not be read
    // as a binding either way: falling through leaves the cap resolved by
    // steps 2–4 exactly as it was before the operator touched the picker.
    if (wrapperAddonId === undefined) continue
    // A stored activation of a wrapper this cap no longer HAS (a retired
    // wrapper, e.g. `virtual-doorbell` on `doorbell`, slice 6): routing it
    // would shadow the native behind an addon that is gone. It is ignored —
    // NOT marked seen, so steps 3/4 resolve the native as if the row were
    // absent — and said once, by name (task 17 review M1).
    if (isRetiredWrapperActivation(capName, wrapperAddonId)) {
      deps.staleWrapperActivations.report(deviceId, capName, wrapperAddonId)
      continue
    }
    const hubLocalNative = deps.capabilityRegistry?.getNativeAddonId(capName, deviceId) ?? null
    const remoteNative = resolveRemote(capName)
    const nativeAddonId = hubLocalNative ?? remoteNative?.addonId ?? ''
    const nativeNodeId = hubLocalNative
      ? (deps.ctx.kernel.localNodeId ?? 'hub')
      : (remoteNative?.nodeId ?? deps.ctx.kernel.localNodeId ?? 'hub')
    // Operator explicitly disabled the wrapper AND no native is available
    // → cap is genuinely off for this device. Mark it seen so step 2's
    // defaultActive auto-bind doesn't silently re-bind the wrapper.
    if (wrapperAddonId === null && !nativeAddonId) {
      seenCaps.add(capName)
      continue
    }
    entries.push({
      capName,
      kind: wrapperAddonId ? 'wrapped' : 'native',
      providerAddonId: wrapperAddonId ?? nativeAddonId,
      providerNodeId: wrapperAddonId
        ? resolveWrapperNodeId(wrapperAddonId)
        : toRoutableProviderNodeId(nativeNodeId),
      nativeAddonId,
    })
    seenCaps.add(capName)
  }

  // 2. Auto-activated wrappers — any cap a wrapper addon declared with
  //    `defaultActive: true` claims the binding HERE, ahead of native
  //    discovery. The wrapper is the active provider; it delegates to
  //    the native via `ctx.getNativeProvider`, so "wrapper decorates
  //    native" is the intended runtime shape and the cap router resolves
  //    locally on the wrapper's node instead of trying to forward to the
  //    native's worker (cap routers like `snapshot` are mounted without
  //    a `createRemoteProxy` because the wrapper handles cross-process
  //    delegation internally).
  //
  //    Step 1 (persisted activations) still wins: an operator-toggled
  //    deactivation marks the cap seen with no entry, blocking this
  //    branch from re-binding the wrapper.
  //
  //    Pure-wrapper caps (motion-detection, audio-analysis,
  //    detection-pipeline) have NO native — the wrapper is the only
  //    implementation. They still bind here with an empty `nativeAddonId`
  //    so consumers (UI bindings table, pipeline-orchestrator's
  //    `isCapActiveForDevice` gate) see the wrapper as active by default.
  //    Mirrors the fallback semantics of step 1 (`?? ''`).
  //
  //    The bind is GATED on the cap's declared `deviceTypes` (D4). Without
  //    that gate the whole camera battery (snapshot, detection-pipeline,
  //    camera-streams, webrtc-session, …) auto-bound onto every device in the
  //    fleet: a Homematic button child (`event-emitter` 1446) answered with 13
  //    entries, 9 of them meaningless, each one then costing a real aggregate
  //    round-trip that could only ever time out. Steps 1/3/4 are NOT gated —
  //    an operator activation and a driver's own native registration are
  //    statements of fact, not speculation.
  if (presence === 'absent') {
    deps.ctx.logger.debug('bindings requested for absent device — returning none', {
      tags: { deviceId },
    })
  } else if (deps.capabilityRegistry) {
    const skippedForType: string[] = []
    for (const capName of deps.capabilityRegistry.getCapsWithDefaultWrapper()) {
      if (seenCaps.has(capName)) continue
      if (!capAppliesToDeviceType(deps.capabilityRegistry.getDefinition(capName), deviceType)) {
        skippedForType.push(capName)
        continue
      }
      const defaultWrapperAddonId = deps.capabilityRegistry.getDefaultWrapperForCap(capName)
      if (!defaultWrapperAddonId) continue
      const hubLocalNative = deps.capabilityRegistry.getNativeAddonId(capName, deviceId) ?? null
      const remoteNative = resolveRemote(capName)
      const nativeAddonId = hubLocalNative ?? remoteNative?.addonId ?? ''
      entries.push({
        capName,
        kind: 'wrapped',
        providerAddonId: defaultWrapperAddonId,
        providerNodeId: resolveWrapperNodeId(defaultWrapperAddonId),
        nativeAddonId,
      })
      seenCaps.add(capName)
    }
    // A silently skipped bind reads as "the cap was never a candidate". Say so
    // once per call, at debug, tagged so it is answerable per-camera.
    if (skippedForType.length > 0) {
      deps.ctx.logger.debug('getBindings: default wrappers skipped — deviceTypes mismatch', {
        tags: { deviceId },
        meta: { deviceType, skipped: skippedForType },
      })
    }
  }

  // 3. Entries from hub-local registered natives (no wrapper configured)
  if (deps.capabilityRegistry) {
    for (const capName of deps.capabilityRegistry.getNativeCapsForDevice(deviceId)) {
      if (seenCaps.has(capName)) continue
      const nativeAddonId = deps.capabilityRegistry.getNativeAddonId(capName, deviceId) ?? ''
      entries.push({
        capName,
        kind: 'native',
        providerAddonId: nativeAddonId,
        providerNodeId: deps.ctx.kernel.localNodeId ?? 'hub',
        nativeAddonId,
      })
      seenCaps.add(capName)
    }
  }

  // 4. Entries from remote (forked-worker) native caps. Sourced from two
  //    complementary feeds, union'd to cover all scenarios:
  //
  //    a) `remoteNativeCaps` — push-fed by `DeviceBindingsChanged` events
  //       emitted by workers on `ctx.registerNativeCap`. Accurate in the
  //       steady state and during normal device boot.
  //
  //    b) `ctx.kernel.listClusterNativeCaps()` — handshake-fed by the D3
  //       `$hub.registerNode` re-handshake that fires after device restore
  //       completes. Covers the Moleculer transport window where push events
  //       were lost (hub restart, crash-respawn, restartAddon). This is the
  //       reliable replacement for the deleted `syncWorkerNativeCaps` pull.
  //
  //    We iterate `remoteNativeCaps` first (push wins for already-seen caps),
  //    then fold in any handshake-fed entries not yet in the push cache.
  const pushFed = deps.remoteNativeCaps.get(deviceId)
  if (pushFed) {
    for (const [capName, info] of pushFed) {
      if (seenCaps.has(capName)) continue
      entries.push({
        capName,
        kind: 'native',
        providerAddonId: info.addonId,
        providerNodeId: toRoutableProviderNodeId(info.nodeId),
        nativeAddonId: info.addonId,
      })
      seenCaps.add(capName)
    }
  }
  // Fold in handshake-fed entries not covered by the push cache. Prefer the
  // O(caps-for-device) indexed lookup (the per-device `deviceId !==` guard
  // below stays a correct no-op on that already-scoped slice); fall back to
  // the whole-cluster flat view when the host doesn't expose it.
  const clusterCaps =
    deps.ctx.kernel.listClusterNativeCapsForDevice?.(deviceId) ??
    deps.ctx.kernel.listClusterNativeCaps?.()
  if (clusterCaps) {
    for (const entry of clusterCaps) {
      if (entry.deviceId !== deviceId) continue
      if (seenCaps.has(entry.capName)) continue
      if (!entry.addonId) continue
      // Skip hub-local — already handled by step 3 (capabilityRegistry).
      const localNodeId = deps.ctx.kernel.localNodeId ?? 'hub'
      if (entry.nodeId === localNodeId) continue
      entries.push({
        capName: entry.capName,
        kind: 'native',
        providerAddonId: entry.addonId,
        providerNodeId: toRoutableProviderNodeId(entry.nodeId),
        nativeAddonId: entry.addonId,
      })
      seenCaps.add(entry.capName)
    }
  }

  return { deviceId, entries }
}

/**
 * A NAMED set of devices' bindings, in one round-trip.
 *
 * Same resolver as `getBindings`, so the routing rules and the per-device
 * shape are identical by construction. It exists because the gap between one
 * device and all 988 had nothing in it: measured on the live hub 2026-08-25, a
 * caller needing seventy-five paid either 75 round-trips (1211 ms / 118 KB) or
 * `getAllBindings` (511 ms / 679 KB of mostly-unwanted rows).
 *
 * Sequential on purpose, like `getAllBindings`: `resolveBindingsForDevice`'s
 * remaining per-device work is the routing rules, which run on this process's
 * own event loop, so concurrency buys nothing there and a fan-out of
 * `Promise.all` over hundreds of ids only makes the queue less fair to
 * everything else on it. Both parts that DO amortise across the whole set are
 * fetched ONCE, ahead of the loop, and in parallel with each other:
 *
 *  - the device rows ({@link DeviceRowStore.getMany}) rather than once per
 *    iteration — measured on the live hub 2026-08-25, `get
 *    device-manager:devices` ran 1 656 calls/min steady-state, one row per
 *    call, which is exactly what looping `getBindings`'s own
 *    `rows.get(deviceId)` here produced;
 *  - the wrapper-activation blob, which the per-device resolver used to read
 *    itself — a second settings-door round trip per id, on the call that
 *    exists precisely so a caller needing many devices does not pay per
 *    device. Measured on the live hub 2026-08-30, mid-drain:
 *    `getBindingsBatch` of 1 id = 5.78 s, of 8 ids = 17.16 s — a slope of
 *    1.63 s PER ADDITIONAL DEVICE, on a call that ships 4.5 KB a row.
 */
export async function getBindingsBatch(
  deps: BindingsDeps,
  input: {
    deviceIds: readonly number[]
  },
): Promise<Array<{ deviceId: number; entries: DeviceBindingEntry[] }>> {
  const ids = [...new Set(input.deviceIds)]
  const [rows, store] = await Promise.all([deps.rows.getMany(ids), readBindingsStore(deps)])
  // The once-per-process retired-wrapper check rides on a store already read.
  deps.staleWrapperActivations.checkStore(store)
  const pass: BindingsPass = { store, ledgerNonEmpty: onceLedgerNonEmpty(deps) }
  const out: Array<{ deviceId: number; entries: DeviceBindingEntry[] }> = []
  for (const deviceId of ids) {
    out.push(await resolveBindingsForDevice(deps, deviceId, rows.get(deviceId) ?? null, pass))
  }
  return out
}

/**
 * Whole-fleet binding dump. Iterates every device known to the
 * deviceRegistry and reuses the per-device `getBindings` resolver
 * for each — same routing rules, single round-trip. Used by
 * `SystemManager.init()` for warm-boot.
 *
 * Bindings change rarely (wrapper toggle, device add/remove) so
 * clients invalidate via the existing
 * `capability.binding-changed` event rather than re-fetching this
 * payload periodically.
 *
 * **"Single round-trip" was a claim, not a fact, until 2026-08-30.** The
 * per-device resolver read the wrapper-activation blob itself, so this call
 * issued one settings-door RPC per device — 1 020 of them on the live
 * 1 019-device hub, at ~2.9 s each while the storage drain ran. It did not
 * return in 240 s, and `SystemMirror.init` gives it 15 s, so the admin UI
 * could not boot at all. Now the whole pass costs exactly TWO reads (the fleet
 * listing and the blob), issued in parallel, and nothing in the loop awaits a
 * store.
 */
export async function getAllBindings(
  deps: BindingsDeps,
): Promise<Array<{ deviceId: number; entries: DeviceBindingEntry[] }>> {
  // The PERSISTED ledger is the device index — it is what `getBindings` itself
  // reads, and it is present wherever this provider runs. The registry is not:
  // `ctx.kernel.deviceRegistry` is hub-only, and this returned `[]` on the live
  // hub while `getBindings({deviceId})` answered correctly for every device
  // tried. Its stated consumer is `SystemManager.init()`'s warm boot, so warm
  // boot was getting nothing — silently, which is the part that made it survive.
  const [fleet, store] = await Promise.all([deps.rows.listAll(), readBindingsStore(deps)])
  // The once-per-process retired-wrapper check rides on a store already read.
  deps.staleWrapperActivations.checkStore(store)
  const rowById = new Map<number, DeviceRow>()
  const ids = new Set<number>()
  for (const row of fleet) {
    rowById.set(row.meta.id, row)
    ids.add(row.meta.id)
  }
  // Union with the registry when there is one: a device constructed but not yet
  // persisted still has bindings worth reporting.
  const registered = deps.ctx.kernel?.deviceRegistry?.getAll() ?? []
  for (const device of registered) ids.add(device.id)
  if (ids.size === 0) {
    deps.ctx.logger.warn('getAllBindings found no devices — warm boot will see nothing', {
      meta: { hasRegistry: deps.ctx.kernel?.deviceRegistry !== undefined },
    })
    return []
  }
  // The fleet listing above already IS every row this pass needs — looping
  // `getBindings` on top of it re-read each one with its own
  // `rows.get(deviceId)`, one primary-key lookup per device, on a call whose
  // whole point is to be the ONE round trip. A device the registry knows but
  // the ledger doesn't (constructed, not yet persisted) simply has no row —
  // `resolveBindingsForDevice` already treats `null` as "not in the ledger"
  // via `resolveDevicePresence`'s registry-first check.
  const pass: BindingsPass = { store, ledgerNonEmpty: onceLedgerNonEmpty(deps) }
  const out: Array<{ deviceId: number; entries: DeviceBindingEntry[] }> = []
  for (const deviceId of [...ids].sort((a, b) => a - b)) {
    out.push(await resolveBindingsForDevice(deps, deviceId, rowById.get(deviceId) ?? null, pass))
  }
  return out
}

/**
 * The ids of every device bound to at least one of `capNames`, ascending.
 *
 * Built on {@link getAllBindings} so the routing rules (native, wrapped,
 * remote) are the ones `getBindings` applies — a second resolver is how the
 * two would drift. Only ids leave: the whole point is that a caller asking
 * "which devices are openings" does not receive 1 000 binding maps (D636).
 */
export interface ListDeviceIdsByCapsInput {
  readonly capNames: readonly string[]
}

export async function listDeviceIdsByCaps(
  deps: BindingsDeps,
  input: ListDeviceIdsByCapsInput,
): Promise<number[]> {
  const wanted = new Set(input.capNames)
  const all = await getAllBindings(deps)
  return all
    .filter((row) => row.entries.some((entry) => wanted.has(entry.capName)))
    .map((row) => row.deviceId)
}

/**
 * Resolve a numeric deviceId to a stableId via persisted meta.
 * Used by callers that need a persisted stableId when the live registry
 * does not hold the device (cross-process / mid-restart). Formerly fed
 * the Config Identity section; that section left Config for Overview.
 * aggregator (see `buildBaseDeviceSection`) to surface the stableId as
 * a readonly display field. All runtime/registry lookups are keyed by
 * numeric deviceId; this helper is display-only.
 */
export async function lookupPersistedStableId(
  deps: BindingsDeps,
  deviceId: number,
): Promise<string | undefined> {
  const row = await deps.rows.get(deviceId)
  return row?.meta.stableId
}
