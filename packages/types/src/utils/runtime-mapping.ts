/**
 * Canonical runtime/backend/format mapping utilities.
 *
 * This is the SINGLE SOURCE OF TRUTH for mapping between:
 * - Pipeline config (runtime: 'python', backend: 'cpu'|'coreml'|'openvino'|...)
 * - DetectionRuntime ('onnx'|'coreml'|'pytorch'|'openvino'|'tflite')
 * - ModelFormat ('onnx'|'coreml'|'openvino'|'tflite'|'pt')
 *
 * Import from '@camstack/types' — do NOT duplicate these mappings anywhere.
 */
import type { ModelFormat } from '../types/models.js'
import type { DetectionRuntime } from '../types/config.js'

// ---------------------------------------------------------------------------
// Pipeline runtime: the two-level abstraction used in pipeline config
// ---------------------------------------------------------------------------

/**
 * Pipeline-level runtime. Only `'python'`: every model runs in a Python pool.
 * The `'node'` runtime (onnxruntime-node in the addon process) is gone, and
 * with it the node-backend → format map that turned `coreml` into `.onnx`.
 */
export type PipelineRuntime = 'python'

// ---------------------------------------------------------------------------
// Backend → Format
// ---------------------------------------------------------------------------

/**
 * DEVICE-POOL backend → model format — the SSOT for the multi-device inference
 * DESCRIPTOR path (Python per-device pools),  distinct from the former BACKEND_TO_FORMAT,
 * which was the removed NODE runtime map (where `coreml → onnx` because
 * onnxruntime-node's CoreML EP loaded `.onnx`). A device pool runs the
 * backend NATIVELY, so `coreml → coreml` and `edgetpu → tflite`. Consumed by
 * `resolveDeviceEngine` (addon-pipeline) and the orchestrator's
 * `parseDeviceKey`/`getNodeInferenceDevices` — the previously-duplicated
 * `BACKEND_FORMAT` maps (R3/node-F2). `cpu`/`cuda` floor to onnx.
 */
const DEVICE_BACKEND_TO_FORMAT: Readonly<Record<string, ModelFormat>> = {
  openvino: 'openvino',
  edgetpu: 'tflite',
  coreml: 'coreml',
  onnx: 'onnx',
  cpu: 'onnx',
  cuda: 'onnx',
}

/**
 * Resolve a DEVICE-POOL backend to its model format via {@link DEVICE_BACKEND_TO_FORMAT},
 * flooring unknown backends to `onnx`. The single entry point both addons call.
 */
function deviceBackendToFormat(backend: string): ModelFormat {
  return DEVICE_BACKEND_TO_FORMAT[backend] ?? 'onnx'
}

/**
 * Map DetectionRuntime to ModelFormat.
 * Used when the addon receives an explicit runtime (not 'auto').
 */
const RUNTIME_TO_FORMAT: Readonly<Record<DetectionRuntime, ModelFormat>> = {
  onnx: 'onnx',
  coreml: 'coreml',
  openvino: 'openvino',
  tflite: 'tflite',
  pytorch: 'pt',
}

/**
 * Map a Python backend to the Python inference script name.
 */
const PYTHON_SCRIPT: Readonly<Record<string, string>> = {
  coreml: 'coreml_inference.py',
  pytorch: 'pytorch_inference.py',
  openvino: 'openvino_inference.py',
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the model format for a given DetectionRuntime.
 */
export function formatForRuntime(runtime: DetectionRuntime): ModelFormat {
  return RUNTIME_TO_FORMAT[runtime]
}

/**
 * Get the Python inference script name for a backend.
 * Returns undefined if no Python script is needed (e.g., 'cpu' uses ONNX).
 */
export function pythonScriptForBackend(backend: string): string | undefined {
  return PYTHON_SCRIPT[backend]
}

/**
 * Check if a DetectionRuntime requires a Python binary.
 * 'coreml', 'pytorch', 'openvino' need Python; 'onnx' and 'tflite' don't.
 */
export function requiresPython(runtime: DetectionRuntime | string): boolean {
  return runtime === 'coreml' || runtime === 'pytorch' || runtime === 'openvino'
}

// Re-export constants for consumers that need the raw maps (e.g., UI filtering)
export { DEVICE_BACKEND_TO_FORMAT, deviceBackendToFormat, RUNTIME_TO_FORMAT, PYTHON_SCRIPT }
