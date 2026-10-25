import type { z } from 'zod'
import type { CustomActionsSpec } from '../capabilities/custom-actions.js'
import type { AddonApi } from '../generated/addon-api.js'

/**
 * Bind an addon's custom-action catalog to its tRPC surface, returning a
 * typed object with one method per action. Each method:
 *   - Dispatches via `api.addons.custom.mutate({ addonId, action, input })`
 *   - Inputs are typed as `z.infer<spec.input>`
 *   - Outputs are typed as `z.infer<spec.output>`
 *
 * Example:
 *   import { benchmarkActions } from '@camstack/addon-benchmark'
 *   const benchmark = bindAddonActions(ctx.api, 'benchmark', benchmarkActions)
 *   const { runId } = await benchmark.runBenchmark({ iterations: 100, target: 'cam-01' })
 */
export function bindAddonActions<T extends CustomActionsSpec>(
  api: AddonApi,
  addonId: string,
  catalog: T,
): { [K in keyof T]: (input: z.infer<T[K]['input']>) => Promise<z.infer<T[K]['output']>> } {
  const out: Record<string, (input: unknown) => Promise<unknown>> = {}
  for (const action of Object.keys(catalog)) {
    out[action] = (input: unknown) => api.addons.custom.mutate({ addonId, action, input })
  }
  return out as never
}
