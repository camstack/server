/**
 * Adapter factories that bridge the server-side registry/service state into the
 * narrow interfaces that CapRouteResolver (in @camstack/system) requires.
 *
 * Layer note: this file is in server/backend and may import server-side types.
 * The resolver itself (in @camstack/system) must NOT import from here —
 * it depends only on the narrow interfaces (NodeCapAuthority, InProcessProviderLookup)
 * defined in the kernel. These factories are the wiring adapters.
 *
 * nodeIsAgent format rule (from agent-registry.service.ts:74-77):
 *   hub         → 'hub'  → not an agent
 *   hub child   → 'hub/<runnerId>' → not an agent
 *   agent       → bare id with no '/' → agent
 */

import type {
  InProcessProviderLookup,
  InProcessProviderRef,
  NodeCapAuthority,
} from '@camstack/system'

// ---------------------------------------------------------------------------
// Minimal interface for the HubNodeRegistry dependency
// ---------------------------------------------------------------------------

/**
 * Minimal view of HubNodeRegistry that this adapter needs.
 * Keeps the adapter decoupled from the concrete class — only structural match
 * is required. HubNodeRegistry satisfies this interface structurally.
 */
export interface NodeRegistryLike {
  getNodeManifest(
    nodeId: string,
  ): readonly { readonly addonId: string; readonly capabilities: readonly string[] }[] | undefined
  listNodeIds(): readonly string[]
  /**
   * Optional: returns flat (nodeId, addonId, capName, deviceId) native-cap tuples.
   * When provided, `nodeKnowsCap` and `isNativeCap` also consult native caps so
   * device-scoped native caps (ptz, motion-zones, …) are visible to the resolver.
   */
  listNativeCapEntries?(): readonly {
    readonly nodeId: string
    readonly addonId: string
    readonly capName: string
    readonly deviceId: number
  }[]
}

// ---------------------------------------------------------------------------
// Minimal interface for the CapabilityService dependency
// ---------------------------------------------------------------------------

/**
 * Minimal view of CapabilityService that the InProcessProviderLookup adapter needs.
 * The real CapabilityService satisfies this interface structurally.
 */
export interface CapabilityServiceLike {
  getSingleton(capability: string): Record<string, unknown> | null
  /** Resolve the hub-local provider honoring the 'hub' per-node override. */
  getSingletonForNode?(capability: string, nodeId: string): Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// createNodeCapAuthority
// ---------------------------------------------------------------------------

/**
 * Optional resolver injected into createNodeCapAuthority so that getAddonId
 * can honor per-node singleton overrides and the cluster-global default,
 * constrained to addons the node actually hosts in its manifest.
 */
export interface SingletonNodeResolver {
  /** Bare addonId a node should use for a singleton cap (override→default→first), or null. */
  resolveSingleton(capName: string, nodeId: string): string | null
}

/**
 * Build a NodeCapAuthority backed by a HubNodeRegistry.
 *
 * nodeIsAgent rule: a node is an agent when its id is not 'hub' and does not
 * contain '/' (hub children are `hub/<runnerId>`; agents are bare ids).
 *
 * nodeOnline: uses registry membership — per CLAUDE.md "the registry is the
 * union of registerNode manifests minus disconnected nodes" because
 * `removeNode` is called on `$node.disconnected`. Registry membership is the
 * cleanest, cast-free liveness check.
 *
 * getAgentChildId: always returns null — the hub cannot resolve which forked
 * child under an agent provides a cap (the agent flattens its subtree into
 * one merged manifest). The agent resolves its own child locally (Task 6).
 */
export function createNodeCapAuthority(
  nodeRegistry: NodeRegistryLike,
  resolver?: SingletonNodeResolver,
): NodeCapAuthority {
  return {
    nodeKnowsCap(nodeId: string, capName: string): boolean {
      // Check system (manifest) caps first
      const manifest = nodeRegistry.getNodeManifest(nodeId)
      if (
        manifest !== undefined &&
        manifest.some((addon) => addon.capabilities.includes(capName))
      ) {
        return true
      }
      // Also check device-scoped native caps — these are NOT in the addon manifest
      const nativeEntries = nodeRegistry.listNativeCapEntries?.() ?? []
      return nativeEntries.some((n) => n.nodeId === nodeId && n.capName === capName)
    },

    getAddonId(nodeId: string, capName: string): string | null {
      // Check system (manifest) caps first
      const manifest = nodeRegistry.getNodeManifest(nodeId)
      if (manifest !== undefined) {
        const manifestAddons = manifest
          .filter((addon) => addon.capabilities.includes(capName))
          .map((addon) => addon.addonId)
        if (manifestAddons.length > 0) {
          // Per-node override / global-default resolution, constrained to what
          // the node actually hosts. Falls back to the first manifest match.
          const resolved = resolver?.resolveSingleton(capName, nodeId) ?? null
          if (resolved !== null && manifestAddons.includes(resolved)) return resolved
          return manifestAddons[0] ?? null
        }
      }
      // Check device-scoped native caps (unchanged path)
      const nativeEntries = nodeRegistry.listNativeCapEntries?.() ?? []
      const nat = nativeEntries.find((n) => n.nodeId === nodeId && n.capName === capName)
      return nat?.addonId ?? null
    },

    nodeIsAgent(nodeId: string): boolean {
      return nodeId !== 'hub' && !nodeId.includes('/')
    },

    nodeOnline(nodeId: string): boolean {
      // O(1) Map lookup — registry membership is the authoritative liveness
      // check: HubNodeRegistry.removeNode is called on $node.disconnected,
      // so a defined manifest means the node is connected.
      return nodeRegistry.getNodeManifest(nodeId) !== undefined
    },

    listNodeIds(): readonly string[] {
      return nodeRegistry.listNodeIds()
    },

    getAgentChildId(_agentNodeId: string, _capName: string): string | null {
      // The hub cannot resolve the agent's child — the agent resolves locally (Task 6).
      return null
    },

    isNativeCap(nodeId: string, capName: string, deviceId?: number): boolean {
      const nativeEntries = nodeRegistry.listNativeCapEntries?.() ?? []
      if (deviceId !== undefined) {
        return nativeEntries.some(
          (n) => n.nodeId === nodeId && n.capName === capName && n.deviceId === deviceId,
        )
      }
      return nativeEntries.some((n) => n.nodeId === nodeId && n.capName === capName)
    },
  }
}

// ---------------------------------------------------------------------------
// createInProcessProviderLookup
// ---------------------------------------------------------------------------

/**
 * Build an InProcessProviderLookup backed by a CapabilityService.
 *
 * Cast-free design: `getSingleton<Record<string, unknown>>` makes the provider
 * indexable without any `as` casts. `typeof fn === 'function'` narrows to
 * Function (implicit `any` return); calling via `fn.call(provider, args)` is
 * then safe and the result is captured as `unknown`. No `as` casts anywhere.
 */
export function createInProcessProviderLookup(
  capabilityService: CapabilityServiceLike,
): InProcessProviderLookup {
  return (capName: string): InProcessProviderRef | null => {
    const provider =
      capabilityService.getSingletonForNode?.(capName, 'hub') ??
      capabilityService.getSingleton(capName)
    if (provider === null || provider === undefined) return null
    return buildProviderRef(capName, provider)
  }
}

/**
 * NODE-ACCURATE variant of {@link createInProcessProviderLookup}: resolves a
 * provider ONLY when one is physically resident on the hub node
 * (`getSingletonForNode(cap, 'hub')`) — no fallback to the cluster-elected
 * ACTIVE singleton.
 *
 * Rationale: `getSingleton(cap)` returns the elected provider OBJECT, which
 * for a remote election is a Moleculer-proxy registered in the hub registry.
 * That fallback is correct for UNPINNED singleton dispatch (election
 * adherence) but must never satisfy an explicit `nodePin('hub')` — the
 * "hub-in-process" route would silently execute on another node (the shm
 * frame-plane cross-node decoder-session storm: a `decoder` call pinned to
 * the hub landed on a remote agent whenever the hub's decoder runner was
 * circuit-broken). Wired into `CapRouteResolver.hubResidentProviders`.
 */
export function createHubResidentProviderLookup(
  capabilityService: CapabilityServiceLike,
): InProcessProviderLookup {
  return (capName: string): InProcessProviderRef | null => {
    const provider = capabilityService.getSingletonForNode?.(capName, 'hub')
    if (provider === null || provider === undefined) return null
    return buildProviderRef(capName, provider)
  }
}

/** Shared cast-free InProcessProviderRef builder over a provider object. */
function buildProviderRef(
  capName: string,
  provider: Record<string, unknown>,
): InProcessProviderRef {
  return {
    invoke: (method: string, args: unknown): Promise<unknown> => {
      const fn = provider[method]
      if (typeof fn !== 'function') {
        return Promise.reject(new Error(`method "${method}" not found on cap "${capName}"`))
      }
      const result: unknown = fn.call(provider, args)
      return Promise.resolve(result)
    },
  }
}
