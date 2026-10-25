/**
 * What is resident in THIS node's executor — the read behind `pipelineRuntime`
 * and `pipelineModels` on the `pipeline stats` lines (D463).
 *
 * The runner and `detection-pipeline` share the `detection` group: one process
 * (`package.json` → `execution.group`). The `pipeline-executor` provider
 * registered in this process is therefore the node's own, and
 * `ctx.capabilities.get` returns it local-first (`buildCapabilitiesAccess`:
 * the process registry before anything remote; a forked UDS child sees ONLY
 * its own process). The cluster route (`ctx.api.pipelineExecutor`) is the
 * wrong question: the cap is a singleton, so it answers with the
 * cluster-ACTIVE provider — the hub's — and agent-b, running
 * `yolov9s-320-edgetpu` on `edgetpu:usb`, printed the hub's `openvino/npu`
 * and `yolov9m-640-int8`. A label that can describe another machine is worse
 * than none: no local executor is a named failure, never a fallback to it.
 */
import type { CapabilitiesAccess } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { ResidentEngine } from './runtime-labels.js'

export const NO_LOCAL_EXECUTOR = 'no pipeline-executor provider in this process'

/** One entry of `listLoadedEngines`, the fields the labels read. */
export interface LocalLoadedEngine {
  readonly engine: { readonly backend: string; readonly device?: string }
  readonly kind: 'runtime' | 'device-pool'
  readonly modelsLoaded: readonly string[]
}

/** The slice of the in-process `pipeline-executor` provider this read uses. */
export interface LocalEngineLister {
  listLoadedEngines(): Promise<readonly LocalLoadedEngine[]>
}

export type LocalResidentRead =
  | { readonly kind: 'read'; readonly engines: readonly ResidentEngine[] }
  | { readonly kind: 'failed'; readonly error: string }

/**
 * The provider is the co-tenant's own object, in this process; the guard
 * checks the one method this read calls (the type boundary of an
 * untyped registry lookup).
 */
function isLocalEngineLister(value: unknown): value is LocalEngineLister {
  return (
    typeof value === 'object' &&
    value !== null &&
    'listLoadedEngines' in value &&
    typeof value.listLoadedEngines === 'function'
  )
}

export async function readLocalResidentEngines(
  capabilities: CapabilitiesAccess | undefined,
): Promise<LocalResidentRead> {
  const provider: unknown = capabilities?.get('pipeline-executor')
  if (!isLocalEngineLister(provider)) return { kind: 'failed', error: NO_LOCAL_EXECUTOR }
  try {
    const resident = await provider.listLoadedEngines()
    return {
      kind: 'read',
      // The cap nests the engine choice; the labels only need three fields.
      engines: resident.map((r) => ({
        backend: r.engine.backend,
        ...(r.engine.device !== undefined ? { device: r.engine.device } : {}),
        kind: r.kind,
        modelsLoaded: r.modelsLoaded,
      })),
    }
  } catch (err: unknown) {
    return { kind: 'failed', error: errMsg(err) }
  }
}
