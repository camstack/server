import type { StatusMetricsSource } from './agent-service.js'

/**
 * The metrics source `$agent.status` reads (and so the agent's own local page).
 *
 * A PAIRED agent boots the `metrics-provider` addon, so the registry answers. An
 * UNPAIRED agent boots no addon at all (agent-boot-mode.ts), the registry has no
 * provider, and the page read memory as unknown although the host reader works. The
 * fallback is the SAME native reader the addon registers - never a second formula -
 * and it is asked only when the registry has nothing.
 */
export function resolveStatusMetrics(
  fromRegistry: () => StatusMetricsSource | null,
  fallback: () => StatusMetricsSource | null,
): () => StatusMetricsSource | null {
  return () => fromRegistry() ?? fallback()
}
