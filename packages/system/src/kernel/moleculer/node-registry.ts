/**
 * HubNodeRegistry — the single authority for which capabilities each
 * cluster node provides. Holds the union of node manifests delivered by
 * the D3 `$hub.registerNode` handshake; a node is dropped on
 * `$node.disconnected`. Pure data — no Moleculer, no timers, no scan.
 */

/**
 * A capability call function — routes a method call to a remote cap provider
 * via Moleculer. Moved here from `capability-bridge.ts` when that file was
 * deleted as part of the D3 clean-up (Task 11).
 */
type CallFn = (method: string, params: unknown, targetNodeId?: string) => Promise<unknown>

/** One addon's contribution within a node's registration manifest. */
interface RegisteredAddonManifest {
  readonly addonId: string
  readonly capabilities: readonly string[]
}

/**
 * One device-scoped native cap a node hosts, with the device ids that
 * registered it and the addonId of the registering addon. Device-scoped
 * native caps (`ctx.registerNativeCap` from a `BaseDevice` subclass) are
 * registered per device AFTER the node's system caps, once background device
 * restore completes — so the node re-handshakes carrying these once they are
 * known (D3 idempotent replace).
 *
 * `addonId` is required for the hub to build the correct Moleculer proxy
 * target (`<addonId>.native-provider.<capName>.<method>`). It replaces the
 * pull-based `syncWorkerNativeCaps` discovery sweep (Task 13).
 */
interface RegisteredNativeCap {
  readonly capName: string
  readonly addonId: string
  readonly deviceIds: readonly number[]
}

/**
 * A node's runtime-updatable ROOT package identity (`@camstack/server` — the
 * single root package for every node role) — carried in the `registerNode`
 * manifest so the hub knows every node's exact software version (design:
 * runtime-updatable node packages, "visibility"). Version skew is SEEN in
 * the UI instead of discovered via a black-hole.
 */
interface NodeRootPackageInfo {
  readonly name: string
  readonly version: string
}

/** Payload of the `$hub.registerNode` RPC — a node's COMPLETE manifest. */
interface RegisterNodeParams {
  readonly nodeId: string
  readonly addons: readonly RegisteredAddonManifest[]
  /**
   * Device-scoped native caps the node hosts. Optional — absent (or empty)
   * on the FIRST handshake, populated by the re-handshake the node fires
   * after `runWorkerDeviceRestoreWithRetry` completes. Each entry includes
   * the registering `addonId` so the hub can build the correct Moleculer
   * proxy target without the pull-based discovery sweep (Task 13).
   */
  readonly nativeCaps?: readonly RegisteredNativeCap[]
  /**
   * The node's root-package identity. Optional — absent from UDS child
   * manifests and pre-phase-2 agents; present on agents running the
   * runtime-updatable root model.
   */
  readonly rootPackage?: NodeRootPackageInfo
}

/** Ack returned by `$hub.registerNode` — presence of `ok` is the signal. */
interface RegisterNodeResult {
  readonly ok: true
  /**
   * The `@camstack/server` version the HUB runs, when it knows it. Lets an agent align its own
   * closure to the hub's without a second call; absent from an older hub.
   */
  readonly hubServerVersion?: string
}

/** Flattened registry view: one row per (node, addon, capability). */
interface NodeCapEntry {
  readonly nodeId: string
  readonly addonId: string
  readonly capName: string
}

/** Flattened native-cap view: one row per (node, native cap, device). */
interface NodeNativeCapEntry {
  readonly nodeId: string
  readonly addonId: string
  readonly capName: string
  readonly deviceId: number
}

class HubNodeRegistry {
  /** nodeId → its complete addon manifest (last `registerNode` wins). */
  private readonly nodes = new Map<string, readonly RegisteredAddonManifest[]>()
  /** nodeId → its device-scoped native caps (last `registerNode` wins). */
  private readonly nativeCaps = new Map<string, readonly RegisteredNativeCap[]>()
  /** nodeId → its root-package identity (last `registerNode` wins). */
  private readonly rootPackages = new Map<string, NodeRootPackageInfo>()
  /**
   * deviceId → flat native-cap entries for THAT device, across all nodes.
   * Maintained incrementally on every `registerNode`/`removeNode` so a
   * per-device lookup is O(caps-for-device) instead of flattening the whole
   * cluster (`listNativeCapEntries()`) and filtering — the latter makes the
   * per-device `getBindings`, run for every device in `getAllBindings`, an
   * O(D²·C) boot-time hot spot. Insertion order mirrors `listNativeCapEntries`
   * (node-registration order) so consumers that take the first match are
   * unaffected.
   */
  private readonly nativeCapsByDevice = new Map<number, NodeNativeCapEntry[]>()

  /**
   * Drop every `nativeCapsByDevice` entry contributed by `nodeId`, reading the
   * node's CURRENT (about-to-be-replaced) native caps to know which device
   * rows it touched. Must run BEFORE `nativeCaps` is overwritten/deleted.
   */
  private dropNodeFromDeviceIndex(nodeId: string): void {
    const current = this.nativeCaps.get(nodeId)
    if (!current) return
    const touched = new Set<number>()
    for (const cap of current) {
      for (const deviceId of cap.deviceIds) touched.add(deviceId)
    }
    for (const deviceId of touched) {
      const arr = this.nativeCapsByDevice.get(deviceId)
      if (!arr) continue
      const remaining = arr.filter((e) => e.nodeId !== nodeId)
      if (remaining.length === 0) this.nativeCapsByDevice.delete(deviceId)
      else this.nativeCapsByDevice.set(deviceId, remaining)
    }
  }

  /**
   * Replace the node's ENTIRE manifest atomically — addons AND native
   * caps. Idempotent: a reconnect, hot-update, or post-device-restore
   * re-handshake simply overwrites. Partial state is impossible because
   * the node sends its complete picture every time.
   */
  registerNode(params: RegisterNodeParams): void {
    // Drop this node's previous device-index rows BEFORE overwriting its
    // nativeCaps, so a re-handshake replaces (never duplicates) its entries.
    this.dropNodeFromDeviceIndex(params.nodeId)

    this.nodes.set(
      params.nodeId,
      params.addons.map((a) => ({ addonId: a.addonId, capabilities: [...a.capabilities] })),
    )
    const caps: readonly RegisteredNativeCap[] = (params.nativeCaps ?? []).map((n) => ({
      capName: n.capName,
      addonId: n.addonId ?? '',
      deviceIds: [...n.deviceIds],
    }))
    this.nativeCaps.set(params.nodeId, caps)

    if (params.rootPackage !== undefined) {
      this.rootPackages.set(params.nodeId, {
        name: params.rootPackage.name,
        version: params.rootPackage.version,
      })
    } else {
      // A re-handshake without the field replaces the WHOLE manifest — keep
      // the atomic-replace semantic for the root package too.
      this.rootPackages.delete(params.nodeId)
    }

    for (const cap of caps) {
      for (const deviceId of cap.deviceIds) {
        const entry: NodeNativeCapEntry = {
          nodeId: params.nodeId,
          addonId: cap.addonId,
          capName: cap.capName,
          deviceId,
        }
        const arr = this.nativeCapsByDevice.get(deviceId)
        if (arr) arr.push(entry)
        else this.nativeCapsByDevice.set(deviceId, [entry])
      }
    }
  }

  /** Drop a node entirely — caps AND native caps — on `$node.disconnected`. */
  removeNode(nodeId: string): void {
    this.dropNodeFromDeviceIndex(nodeId)
    this.nodes.delete(nodeId)
    this.nativeCaps.delete(nodeId)
    this.rootPackages.delete(nodeId)
  }

  /** The node's root-package identity, or null when it never reported one. */
  getNodeRootPackage(nodeId: string): NodeRootPackageInfo | null {
    return this.rootPackages.get(nodeId) ?? null
  }

  /** The node's manifest, or undefined when the node never registered. */
  getNodeManifest(nodeId: string): readonly RegisteredAddonManifest[] | undefined {
    return this.nodes.get(nodeId)
  }

  /**
   * The node's device-scoped native caps. `[]` when the node registered
   * without any (or has not yet re-handshaked post-device-restore);
   * `undefined` when the node never registered at all.
   */
  getNodeNativeCaps(nodeId: string): readonly RegisteredNativeCap[] | undefined {
    return this.nativeCaps.get(nodeId)
  }

  /** Flat (nodeId, addonId, capName) view of the whole cluster. */
  listEntries(): readonly NodeCapEntry[] {
    const out: NodeCapEntry[] = []
    for (const [nodeId, addons] of this.nodes) {
      for (const addon of addons) {
        for (const capName of addon.capabilities) {
          out.push({ nodeId, addonId: addon.addonId, capName })
        }
      }
    }
    return out
  }

  /** Flat (nodeId, addonId, capName, deviceId) native-cap view of the whole cluster. */
  listNativeCapEntries(): readonly NodeNativeCapEntry[] {
    const out: NodeNativeCapEntry[] = []
    for (const [nodeId, caps] of this.nativeCaps) {
      for (const cap of caps) {
        for (const deviceId of cap.deviceIds) {
          out.push({ nodeId, addonId: cap.addonId, capName: cap.capName, deviceId })
        }
      }
    }
    return out
  }

  /**
   * Native-cap entries for ONE device, across all nodes — O(caps-for-device).
   * Equivalent to `listNativeCapEntries().filter(e => e.deviceId === deviceId)`
   * but served from the incrementally-maintained `nativeCapsByDevice` index, so
   * per-device resolution (and `getAllBindings`, which runs it per device)
   * doesn't flatten the whole cluster each call.
   */
  listNativeCapEntriesForDevice(deviceId: number): readonly NodeNativeCapEntry[] {
    return this.nativeCapsByDevice.get(deviceId) ?? []
  }

  /** Every node id currently registered. */
  listNodeIds(): readonly string[] {
    return [...this.nodes.keys()]
  }
}

export { HubNodeRegistry }
export type {
  CallFn,
  NodeRootPackageInfo,
  RegisteredAddonManifest,
  RegisteredNativeCap,
  RegisterNodeParams,
  RegisterNodeResult,
  NodeCapEntry,
  NodeNativeCapEntry,
}
