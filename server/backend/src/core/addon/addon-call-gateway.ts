/**
 * `AddonCallGateway` — the SINGLE hub-side router for addon-LEVEL calls (the
 * surfaces the removed per-addon Moleculer broker used to carry: routes,
 * custom-actions, settings — see `AddonCallTarget`).
 *
 * Why this exists: that routing decision (is the addon running in-process on
 * the hub, as a forked hub-local CHILD reachable over UDS, or on a REMOTE
 * agent over Moleculer?) used to be duplicated per surface — routes/custom in
 * `addon-registry.service.ts`, settings in `addon-settings-provider.ts`. When
 * the UDS migration ported routes+custom to `callAddonOnChild`, settings was
 * left on the dead `<addonId>.settings.<method>` Moleculer path because nothing
 * centralised "dispatch an addon-level call to wherever the addon runs". Every
 * forked hub-local addon's settings panel silently went empty for months.
 *
 * Now every addon-level surface routes through `callForked` here. Combined with
 * the exhaustive `AddonCallTarget` union (a `never`-checked dispatch in
 * `createChildAddonCallDispatch`), a future surface can't be half-wired without
 * a compile error — the class of "missed link" is closed.
 */
import type { AddonCallInput, LocalChildRegistry } from '@camstack/system'

/** An addon-level call minus its `addonId` — the gateway merges that in. */
export type AddonCallSurface = Omit<AddonCallInput, 'addonId'>

/**
 * Minimal structural view of the Moleculer broker (remote-agent leg) — typed
 * locally because the lint type-checker can't resolve Moleculer's
 * `ServiceBroker` (mirrors the pattern in `addon-settings-provider.ts`).
 */
export interface AddonCallBroker {
  readonly registry: unknown
  call(
    action: string,
    params: Record<string, unknown>,
    opts?: { readonly nodeID?: string; readonly timeout?: number },
  ): Promise<unknown>
}

/** Where an addon physically runs — the routing decision, made in one place. */
export type AddonCallDestination =
  | { readonly kind: 'in-process' }
  | { readonly kind: 'hub-local-child' }
  | { readonly kind: 'remote-agent'; readonly baseNodeId: string }

export interface AddonCallGatewayDeps {
  /** This hub's node id (for the local short-circuit). */
  readonly hubNodeId: string
  /** Which node hosts a given addon ('hub' / hubNodeId = on this hub). */
  readonly resolveNode: (addonId: string) => string
  /**
   * Resolve an addonId to its runner/child id — the addon's
   * `execution.group` when it declares one, else the addon id itself
   * (`resolveRunnerId`). A grouped addon runs in a shared runner whose UDS
   * child id is the GROUP name, so the parent must never assume
   * `childId === addonId`. Identity for every ungrouped addon (the common
   * case), so this is behaviour-preserving there.
   */
  readonly resolveChildId: (addonId: string) => string
  /** UDS registry of forked hub-local children (null before it's wired). */
  readonly getChildRegistry: () => LocalChildRegistry | null
  /** Moleculer broker for the remote-agent leg. */
  readonly broker: AddonCallBroker
}

const REMOTE_TIMEOUT_MS = 10_000

export class AddonCallGateway {
  constructor(private readonly deps: AddonCallGatewayDeps) {}

  /**
   * Classify where an addon runs. `nodeId: 'hub'` from a caller means "the hub
   * cluster", NOT "force in-process" — a forked hub-local addon is still a
   * `hub-local-child` (UDS), never the in-process path (which is only the
   * `@camstack/system` builtins that have no forked runner).
   */
  classify(addonId: string, explicitNodeId?: string): AddonCallDestination {
    const resolved = this.deps.resolveNode(addonId)
    const onHub = resolved === 'hub' || resolved === this.deps.hubNodeId
    if (onHub) {
      const childRegistry = this.deps.getChildRegistry()
      // Resolve to the runner child id: a grouped addon's UDS child is the
      // group name, not the addon id. `isChildKnown(addonId)` would be false
      // for a grouped addon and misclassify it as `in-process`.
      const childId = this.deps.resolveChildId(addonId)
      if (childRegistry !== null && childRegistry.isChildKnown(childId)) {
        return { kind: 'hub-local-child' }
      }
      return { kind: 'in-process' }
    }
    const onThisHub = explicitNodeId === 'hub' || explicitNodeId === this.deps.hubNodeId
    const baseNodeId = explicitNodeId && !onThisHub ? explicitNodeId : resolved
    return { kind: 'remote-agent', baseNodeId }
  }

  /** True when the addon is an in-process hub builtin (caller invokes directly). */
  isInProcess(addonId: string, explicitNodeId?: string): boolean {
    return this.classify(addonId, explicitNodeId).kind === 'in-process'
  }

  /**
   * Dispatch a forked addon-level call to wherever the addon runs:
   *   - `hub-local-child` → UDS `LocalChildRegistry.callAddonOnChild`
   *   - `remote-agent`    → Moleculer `broker.call`
   * Throws for `in-process` — that addon has no forked surface, so the caller
   * must invoke the in-process instance directly (the invocation is
   * surface-specific; only the ROUTING is centralised here).
   */
  async callForked(
    addonId: string,
    input: AddonCallSurface,
    explicitNodeId?: string,
  ): Promise<unknown> {
    const dest = this.classify(addonId, explicitNodeId)
    const fullInput: AddonCallInput = { ...input, addonId }
    switch (dest.kind) {
      case 'hub-local-child': {
        const childRegistry = this.deps.getChildRegistry()
        if (childRegistry === null) {
          throw new Error(`AddonCallGateway: child registry unavailable for "${addonId}"`)
        }
        // Dispatch to the runner CHILD id (group when grouped, else addon id);
        // the payload keeps the real `addonId` so the child fans out to the
        // right co-located addon within the group.
        return childRegistry.callAddonOnChild(this.deps.resolveChildId(addonId), fullInput)
      }
      case 'remote-agent':
        return this.callRemoteAgent(addonId, dest.baseNodeId, fullInput)
      case 'in-process':
        throw new Error(`AddonCallGateway: addon "${addonId}" runs in-process — invoke it directly`)
      default: {
        const _exhaustive: never = dest
        throw new Error(`AddonCallGateway: unhandled destination ${JSON.stringify(_exhaustive)}`)
      }
    }
  }

  /** Map an addon-level call to the remote agent's Moleculer action. */
  private async callRemoteAgent(
    addonId: string,
    baseNodeId: string,
    input: AddonCallInput,
  ): Promise<unknown> {
    const workerNodeId = this.resolveWorkerNodeId(addonId, baseNodeId)
    const opts = workerNodeId
      ? { nodeID: workerNodeId, timeout: REMOTE_TIMEOUT_MS }
      : { timeout: REMOTE_TIMEOUT_MS }
    if (input.target === 'settings') {
      if (input.method == null) {
        throw new Error(`AddonCallGateway: settings call to "${addonId}" missing method`)
      }
      return this.deps.broker.call(
        `${addonId}.settings.${input.method}`,
        (input.args ?? {}) as Record<string, unknown>,
        opts,
      )
    }
    // routes/custom are hub-local-child surfaces (mounted / invoked on the
    // owning node); they are not proxied to a remote agent through this gateway.
    throw new Error(
      `AddonCallGateway: target "${input.target}" not supported for remote agent "${baseNodeId}"`,
    )
  }

  /**
   * Resolve the Moleculer nodeID that actually hosts an addon's service.
   * Forkable addons register under `${baseNodeId}/${addonId}`; in-process
   * addons under the base nodeId. The registry is the ground truth — baseNodeId
   * is a hint. (Moved verbatim from `addon-settings-provider.ts`.)
   */
  private resolveWorkerNodeId(addonId: string, baseNodeId: string): string | null {
    const registry = this.deps.broker.registry
    const services = (
      registry as {
        getServiceList: (opts: {
          onlyAvailable: boolean
        }) => readonly { name: string; nodeID: string }[]
      }
    ).getServiceList({ onlyAvailable: true })
    const exactNode = `${baseNodeId}/${addonId}`
    const preferred = services.find((s) => s.name === addonId && s.nodeID === exactNode)
    if (preferred) return preferred.nodeID
    const anyForBase = services.find((s) => s.name === addonId && s.nodeID === baseNodeId)
    if (anyForBase) return anyForBase.nodeID
    const anyWithName = services.find((s) => s.name === addonId)
    return anyWithName?.nodeID ?? null
  }
}
