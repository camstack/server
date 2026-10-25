/**
 * Cheap local answer to "which python inference runtimes does THIS host
 * support?" — the Cluster page's `engines` badges and the durable node
 * history row. Pure over `probePlatform` + `supportedRuntimes`; no Python
 * import, no platform-probe capability round-trip (those are the heavier
 * path used by the detection pipeline itself).
 *
 * Historically `AgentInfo.pythonRuntimes` was declared and projected into
 * topology `engines`, but nothing ever filled it — every node rendered "—".
 */
import * as os from 'node:os'
import { supportedRuntimes, type GpuInfo, type HardwareInfo, type NpuInfo } from '@camstack/types'
import { probePlatform } from '../hwaccel/hwaccel-resolver.js'
import { mapSignalsToInferenceHardware } from './inference-resolver.js'

function asGpuType(type: string): GpuInfo['type'] | null {
  if (type === 'nvidia' || type === 'amd' || type === 'intel' || type === 'apple') return type
  return null
}

function asNpuType(type: string): NpuInfo['type'] | null {
  if (type === 'apple-ane' || type === 'intel-npu' || type === 'amd-xdna') return type
  return null
}

function localHardwareInfo(): HardwareInfo | null {
  const platform = os.platform()
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null
  const archRaw = os.arch()
  const arch: HardwareInfo['arch'] = archRaw === 'arm64' ? 'arm64' : 'x64'
  const signals = probePlatform()
  const inference = mapSignalsToInferenceHardware(signals)
  const gpuType = inference.gpu ? asGpuType(inference.gpu.type) : null
  const npuType = inference.npu ? asNpuType(inference.npu.type) : null
  const cpus = os.cpus()
  return {
    platform,
    arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCores: cpus.length,
    totalRAM_MB: Math.round(os.totalmem() / 1024 / 1024),
    availableRAM_MB: Math.round(os.freemem() / 1024 / 1024),
    gpu: gpuType !== null ? { type: gpuType, name: gpuType } : null,
    npu: npuType !== null ? { type: npuType } : null,
    coral: inference.coral ?? null,
  }
}

/** Runtime ids offered on this host (`onnx`, `openvino`, `coreml`, `edgetpu`). */
export function localSupportedPythonRuntimes(): readonly string[] {
  return supportedRuntimes(localHardwareInfo())
}
