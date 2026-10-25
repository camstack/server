import { supportedRuntimes, defaultDeviceFor, type RuntimeEnv, type RuntimeId } from './runtimes.js'

// Preference when several runtimes are supported: accelerators before the floor.
// `edgetpu` sits just above the onnx floor: a Coral-only node auto-picks it, but
// it never displaces an Intel (openvino) / Apple (coreml) accelerator — so the
// hub keeps its existing openvino default and only a pure-Coral node adopts it.
const PREFERENCE: readonly RuntimeId[] = ['coreml', 'openvino', 'edgetpu', 'onnx']

export interface EnginePick {
  readonly runtimeId: RuntimeId
  readonly device: string
}

/**
 * Pure function — picks the best supported runtime for the given hardware env.
 *
 * Logic:
 * 1. If `bestBackendHint` is in the supported set, use it.
 * 2. Otherwise, walk PREFERENCE order and pick the first supported runtime.
 * 3. Floor to `'onnx'` (always supported).
 *
 * Device is always `defaultDeviceFor(chosen)`.
 */
export function pickBestRuntime(env: RuntimeEnv, bestBackendHint: string | null): EnginePick {
  const supported = supportedRuntimes(env)
  const hinted = supported.find((id) => id === bestBackendHint)
  const chosen = hinted ?? PREFERENCE.find((id) => supported.includes(id)) ?? 'onnx'
  return { runtimeId: chosen, device: defaultDeviceFor(chosen) }
}
