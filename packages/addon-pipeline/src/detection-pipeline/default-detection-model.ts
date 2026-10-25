/**
 * Hardware-aware default object-detection model.
 *
 * When no operator has chosen a model, the object-detection step's default
 * should match the NODE's accelerator rather than a single flat id. This
 * module maps a node's resolved engine (`backend` + `device`) to a
 * measured-COCO-val2017 balanced default, keyed on the REAL runtime
 * vocabulary this codebase uses:
 *
 *   - `backend` ∈ { 'onnx' | 'openvino' | 'coreml' } (`RuntimeId`)
 *   - `device`  — CoreML: cpu/gpu/ane/all · OpenVINO: auto/cpu/gpu/npu ·
 *                 ONNX: cpu/cuda/coreml  (see `PoolModelConfig.device` doc)
 *
 * Only the OBJECT-DETECTION slot uses this; every other step keeps its flat
 * per-format default. The resolver is called on the hot default-tree path,
 * so it NEVER throws and NEVER returns a model id without a build for the
 * requested format — any unmapped/unknown backend (e.g. `edgetpu`), or a
 * mapped id that lacks a build for the node's format, falls back to the
 * step's PER-FORMAT default (tflite → the Coral SSD build), never to a bare
 * `defaultModelId` that may not ship the format at all.
 */
import { type ModelFormat, OBJECT_DETECTION_STEP_ID, type StepDefinition } from '@camstack/types'
import { getDefaultModelForFormatFromDef, getStepDefinition } from './registry/step-definitions.js'

/** The object-detection step id — the only slot this resolver applies to (owned by `@camstack/types`). */
export { OBJECT_DETECTION_STEP_ID }

/**
 * Accelerator class a node's engine resolves to. Derived from `(backend,
 * device)` — the discriminator that separates an Intel NPU from an Intel
 * iGPU (both `backend: 'openvino'`) and an Apple ANE (`backend: 'coreml'`)
 * from a plain CPU floor.
 */
type AcceleratorClass =
  | 'apple-ane'
  | 'intel-npu'
  | 'intel-gpu'
  | 'openvino-cpu'
  | 'amd-igpu'
  | 'cpu'

/**
 * Balanced default object-detection model per accelerator class. `'cpu'` maps to
 * `null` → the caller substitutes the step's own `defaultModelId` (`yolo26n`).
 * INTEL NPU + iGPU default to the Ultralytics YOLOv9 re-export (int8 @320), which
 * runs on both (~298 fps measured on the NPU). OpenVINO CPU (AMD Zen4 path) uses
 * the same int8 IR. AMD iGPU WebGPU uses the ONNX fp32 @320 build. Apple ANE uses
 * the CoreML yolov9 @320 build.
 *
 * Do **not** promote these ids to `yolov9m-640` / `*-640`. The controlled
 * evaluation recovered 0/3 misses at the current 0.50 threshold and failed the
 * false-positive and capacity gates — see
 * `docs/benchmarks/pipeline-frame-model-eval.md`. 640 remains an explicit
 * operator pick, not a hardware-aware default: Pipeline → Cluster → Best
 * settings (D745) may recommend it, from the measured table and the node's
 * load, and writes it only after the operator confirmed the plan.
 */
const MODEL_BY_CLASS: Readonly<Record<AcceleratorClass, string | null>> = {
  'apple-ane': 'yolov9m-320',
  'intel-npu': 'yolov9m-320-int8',
  'intel-gpu': 'yolov9m-320-int8',
  'openvino-cpu': 'yolov9m-320-int8',
  // Warm ~192 ms on agent-b WebGPU; m-320 is ~1 fps and m-640 sheds.
  'amd-igpu': 'yolov9t-320',
  cpu: null,
}

/**
 * Classify a node's engine into an {@link AcceleratorClass} from its resolved
 * `backend` + `device`. Pure, total, never throws.
 *
 * OpenVINO's default device is `'auto'` (the python pool resolves NPU > GPU >
 * CPU at load). Because OpenVINO is only ever OFFERED when an Intel iGPU is
 * present, the GPU is the guaranteed accelerator while the NPU is an explicit
 * opt-in — so `'auto'` (and any non-cpu/non-npu device) is treated as
 * GPU-class conservatively. An operator who explicitly pins `device: 'npu'`
 * gets the NPU-tuned m-320.
 *
 * Also accepts the accelerator carried in the `backend` slot (e.g. `'ane'`,
 * `'mps'`, `'npu'`, `'intel-gpu'`) so a caller passing a device-style backend
 * still classifies correctly — real callers pass onnx/openvino/coreml.
 */
function classifyAccelerator(backend: string, device: string | null): AcceleratorClass {
  const b = backend.toLowerCase()
  const d = device?.toLowerCase() ?? null

  // Apple CoreML — runs on the ANE (default device 'all' includes it).
  if (b === 'coreml' || b === 'ane' || b === 'mps') return 'apple-ane'

  // Intel OpenVINO — the device string discriminates the accelerator.
  // On AMD, OpenVINO is offered as CPU-only (int8 IRs on Zen4 VNNI).
  if (b === 'openvino') {
    if (d === 'npu') return 'intel-npu'
    if (d === 'cpu') return 'openvino-cpu'
    // 'gpu', 'auto', or unknown → GPU-class (see doc-comment rationale).
    return 'intel-gpu'
  }

  // Accelerator carried in the backend slot (task-model aliases / robustness).
  if (b === 'npu' || b === 'intel-npu') return 'intel-npu'
  if (b === 'gpu' || b === 'intel-gpu' || b === 'gpu-openvino') return 'intel-gpu'

  // ONNX WebGPU (AMD iGPU) — device pin `webgpu` on the onnx backend.
  if (b === 'onnx' && d === 'webgpu') return 'amd-igpu'
  if (b === 'webgpu' || b === 'amd-igpu') return 'amd-igpu'

  // onnx (cpu/cuda), 'cpu', 'cuda', or any unknown backend → CPU-safe nano.
  return 'cpu'
}

/**
 * Resolve the hardware-aware default object-detection model id for a node's
 * engine `(backend, device, format)`.
 *
 * Guarantees:
 *   - never throws (hot default-tree path);
 *   - never returns a model id without a build for `format` (unless the step
 *     has ZERO builds for `format`, which is unloadable regardless of pick and
 *     flagged by `collectZeroBuildIssues`) — an unmapped backend, a `'cpu'`
 *     class, a mapped id missing from the catalog, or a mapped id without a
 *     `format` build all fall back to the step's PER-FORMAT default
 *     (`getDefaultModelForFormatFromDef`), NOT the bare `defaultModelId`.
 *
 * `getStepDef` is injectable (defaults to the real catalog lookup) so the
 * missing-build fallback branch is unit-testable without a live catalog —
 * mirrors `collectZeroBuildIssues`' injection seam.
 */
export function resolveDefaultDetectionModel(
  backend: string,
  device: string | null,
  format: ModelFormat,
  getStepDef: (stepId: string) => StepDefinition = getStepDefinition,
): string {
  let def: StepDefinition
  try {
    def = getStepDef(OBJECT_DETECTION_STEP_ID)
  } catch {
    // Step somehow unregistered — the catalog nano is the universal safe id.
    return 'yolo26n'
  }

  const candidate = MODEL_BY_CLASS[classifyAccelerator(backend, device)]
  if (candidate !== null) {
    // Only return the accelerated candidate when it exists in the catalog AND
    // has a build for this node's format.
    const entry = def.models.find((m) => m.id === candidate)
    if (entry && entry.formats[format] !== undefined) return candidate
  }

  // The fallback must satisfy the SAME format guarantee as the candidate.
  // Returning the bare `def.defaultModelId` here is exactly the cam-101
  // outage (2026-08-01): an `edgetpu:usb` dispatch classified as CPU-class,
  // got `yolo26n` back — a model with NO tflite build — and every frame then
  // burned ~5.5s in a doomed 3-retry model download. Route through the
  // per-format default resolver instead, which prefers
  // `defaultModelIdByFormat[format]` (tflite → the Coral SSD build) and only
  // returns a formatless id when the step has ZERO builds for `format`
  // (unloadable either way — flagged by `collectZeroBuildIssues`).
  return getDefaultModelForFormatFromDef(def, format)
}
