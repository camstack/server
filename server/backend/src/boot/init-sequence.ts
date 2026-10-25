/**
 * The hub's `onModuleInit` order, as one named, testable sequence.
 *
 * It was inline in `bootManual`. It is here because one seam in it is now
 * load-bearing rather than incidental — {@link BootInitSequence.beforeAddonBoot}
 * — and a seam nothing pins is a seam that moves.
 *
 * The order is derived from the dependency graph:
 *
 *   1. Moleculer — starts the broker and calls `EventBus.attachBroker()`.
 *   2. AddonBridge — no cross-service deps.
 *   3. AgentRegistry — subscribes to `broker.localBus.on('$node.connected')`.
 *   ── beforeAddonBoot ── the broker is live and NOTHING has booted yet.
 *   4. AddonRegistry — boots EVERY addon. Minutes of work on a real hub.
 *   5. …post-boot reconciles.
 */

/** One `onModuleInit`, sync or async. */
export type InitStep = () => void | Promise<void>

export interface BootInitSequence {
  readonly moleculer: InitStep
  readonly addonBridge: InitStep
  readonly agentRegistry: InitStep
  /**
   * Runs with the broker started and before a single addon has booted.
   *
   * THE reason it exists (D171): the hub's core tRPC routers are bridged onto
   * the mesh as the `$core-caps` Moleculer service, and that service used to be
   * registered only after `app.init()` returned — i.e. after step 4, which IS
   * the addon boot. So for the whole of addon boot, every `ctx.api.<coreCap>`
   * call was not slow, it was structurally unanswerable: `brokerTransportLink`
   * polled the full 30 s discovery deadline and fast-failed, with no
   * boot-window retry, because core caps are excluded from it. One such await
   * on the serial builtin chain held `device-manager`, and with it every
   * camera in the cluster, for 30 s.
   *
   * A failure here must never abort boot — the caller owns that decision, and
   * this sequence does not catch for it.
   */
  readonly beforeAddonBoot?: InitStep
  readonly addonBoot: InitStep
  /** Runs after the addon set is populated (agent reconcile, topology). */
  readonly afterAddonBoot?: InitStep
}

/** Run the boot init steps in dependency order. */
export async function runBootInitSequence(sequence: BootInitSequence): Promise<void> {
  await sequence.moleculer()
  await sequence.addonBridge()
  await sequence.agentRegistry()
  if (sequence.beforeAddonBoot !== undefined) await sequence.beforeAddonBoot()
  await sequence.addonBoot()
  if (sequence.afterAddonBoot !== undefined) await sequence.afterAddonBoot()
}
