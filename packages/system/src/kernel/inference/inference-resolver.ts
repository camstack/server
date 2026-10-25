import type { IKernelInferenceEngine, KernelInferenceHardware } from '@camstack/types'
import { type PlatformSignals, probePlatform } from '../hwaccel/hwaccel-resolver.js'

/**
 * Map the shared platform GPU-vendor probe into the inference `gpu`/`npu` types
 * the runtime scorer understands. NVIDIA → cuda; AMD iGPU → WebGPU/OV-CPU;
 * Intel iGPU (or a bare unknown-vendor render node) → openvino; Apple Silicon
 * → CoreML/ANE; Intel NPU ("AI Boost") → intel-npu. The NPU only bumps the
 * score, never changes the openvino winner, but surfacing it lets the TS
 * hint/UI reflect the accelerator the python pool actually compiles onto
 * (NPU>GPU>CPU). PURE — unit-tested.
 *
 * AMD must win over the `hasRenderNode` fallback: a Phoenix box has a render
 * node AND `hasAmdGpu`, and classifying it as Intel would offer
 * `openvino:gpu`/`npu` that do not exist on the host.
 */
export function mapSignalsToInferenceHardware(signals: PlatformSignals): KernelInferenceHardware {
  const gpu = signals.hasNvidiaGpu
    ? { type: 'nvidia' }
    : signals.hasAmdGpu
      ? { type: 'amd' }
      : signals.hasIntelGpu
        ? { type: 'intel' }
        : signals.hasRenderNode
          ? { type: 'intel' }
          : null
  const npu =
    signals.platform === 'darwin' && signals.arch === 'arm64'
      ? { type: 'apple-ane' }
      : signals.hasIntelNpu
        ? { type: 'intel-npu' }
        : null
  // Coral Edge TPU (USB and/or PCIe) — passed through WHOLE so the
  // detection-pipeline enumerates one device per usable unit and a
  // present-but-unusable Coral keeps its reason (independent of gpu/npu).
  return { gpu, npu, coral: signals.coral }
}

/**
 * Build the local in-process inference-hardware resolver used to populate
 * `ctx.kernel.inferenceEngine`. The exact model as `createKernelHwAccel`:
 * deterministic per host, safe to call repeatedly, always the LOCAL node.
 */
export function createKernelInferenceEngine(): IKernelInferenceEngine {
  return {
    resolveHardware: async () => mapSignalsToInferenceHardware(probePlatform()),
  }
}
