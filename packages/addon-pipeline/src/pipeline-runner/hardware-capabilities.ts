/**
 * The `hardware` block of `RunnerLocalLoad` — what this node can accelerate on.
 *
 * ## Why this file exists
 *
 * `getLocalLoad()` reported a hardcoded `hasGpu: false`. It was not a probe that
 * failed: when the hardware probe was moved off the runner (Phase 4) the field
 * was left as a literal, and it has answered "no GPU" ever since — including on
 * nodes actively running OpenVINO on their Intel iGPU. The admin UI renders a
 * "GPU" badge straight off it, and the orchestrator's hardware-aware balancing
 * reads it, so a stale `false` is a wrong answer, not a missing one.
 *
 * The probe is cheap and local (`ctx.kernel.inferenceEngine.resolveHardware()`
 * is deterministic per host, the same resolver the detection addon uses to pick
 * the node's default engine), and the runner shares a process with the
 * detection pipeline, so there is no cross-node ambiguity: this is THIS node.
 */
import * as os from 'node:os'
import type { KernelInferenceHardware, RunnerHardwareCapabilities } from '@camstack/types'

/**
 * Summarise a local hardware probe into the runner's reported capabilities.
 *
 * `hasGpu` is literal — a GPU, not "an accelerator". An NPU or a Coral is not a
 * GPU and does not set it; they surface per pool through `RunnerLocalLoad.devices`
 * (`openvino:npu`, `edgetpu:usb`, …), which is the finer-grained answer the
 * device balancer weights on. A null probe means "could not tell", which reports
 * as `false` — the same conservative floor the engine cascade takes.
 */
export function summarizeRunnerHardware(
  hardware: KernelInferenceHardware | null,
  cpuCores: number = os.cpus().length,
): RunnerHardwareCapabilities {
  return {
    hasGpu: hardware?.gpu != null,
    cpuCores,
    // Deliberately absent. A node runs a pool per accelerator, so there is no
    // single "the inference backend" to report here; `RunnerLocalLoad.devices`
    // carries the backend of every pool with cameras attached.
  }
}
