/**
 * Minimal configuration port consumed by the shared `NodeRuntime`.
 *
 * The runtime never reaches a concrete config service: hub and agent each
 * supply their own adapter (the hub over its `ConfigService`, the agent over
 * env + `/data/agent.json`). Keeping the surface to a namespaced get/set keeps
 * the runtime host-agnostic — a port leak (the runtime reaching a backend type)
 * must break the agent build, which is the desired signal.
 */
export interface ConfigPort {
  /** Read a namespaced config value (e.g. "capabilities.singleton.storage"). */
  get<T = string>(key: string): T | undefined
  /** Persist a namespaced config value. May be async (storage-backed). */
  set(key: string, value: unknown): void | Promise<void>
}
