/**
 * addon-benchmark — customActions catalog.
 *
 * Dispatched via `api.addons.custom.mutate({ addonId: 'benchmark', action,
 * input })`, served by the hub instance (the addon is hub-only).
 *
 * The one action left is the Image section's single run. The Node benchmark
 * belongs to the pipeline orchestrator (`pipelineOrchestrator.*NodeBenchmark*`,
 * D791), which drives the measured node's own runner; the Audio section calls
 * the executor directly. History and the session replay are gone.
 */
import { customAction, defineCustomActions, PipelineRunResultBridge } from '@camstack/types'
import { PipelineRunInputSchema } from './benchmark-schemas.js'

export const benchmarkActions = defineCustomActions({
  // Image — one run of a step tree on a (node, deviceKey).
  runPipelineTest: customAction(PipelineRunInputSchema, PipelineRunResultBridge, {
    kind: 'mutation',
  }),
})

export type BenchmarkActions = typeof benchmarkActions
