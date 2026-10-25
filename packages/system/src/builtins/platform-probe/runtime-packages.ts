import type { HardwareInfo } from '@camstack/types'

export interface RuntimePackageSet {
  requirementsFiles: string[]
  backendIds: string[]
}

export function resolveRuntimePackages(hardware: HardwareInfo): RuntimePackageSet {
  const requirementsFiles = ['requirements-onnxruntime.txt']
  const backendIds = ['onnx-py']

  if (hardware.platform === 'darwin') {
    requirementsFiles.push('requirements-coreml.txt')
    backendIds.push('coreml')
  }

  // OpenVINO on Intel (GPU/NPU) and on AMD (CPU device only — int8 IRs on Zen4).
  // Wheels exist for Linux and Windows x64; macOS never gets it.
  const wantsOpenvino =
    hardware.gpu?.type === 'intel' ||
    hardware.npu?.type === 'intel-npu' ||
    hardware.gpu?.type === 'amd'
  if ((hardware.platform === 'linux' || hardware.platform === 'win32') && wantsOpenvino) {
    requirementsFiles.push('requirements-openvino.txt')
    backendIds.push('openvino')
  }

  // AMD iGPU via ONNX WebGPU EP — bumps ORT to ≥1.24 and installs the plugin.
  // Linux only: Windows gets its own device key after the NPU spike.
  if (hardware.platform === 'linux' && hardware.gpu?.type === 'amd') {
    requirementsFiles.push('requirements-webgpu.txt')
    backendIds.push('webgpu')
  }

  // Coral Edge TPU (USB or PCIe) — the LiteRT interpreter (`ai-edge-litert`) is
  // pip-installable; the libedgetpu delegate is a native library the deps
  // downloader stages right after it (requirements-edgetpu.txt declares it,
  // `ctx.deps.installPythonRequirements` reads the line). Installed on Coral
  // PRESENCE, usable or not: a PCIe unit whose driver is still missing finds
  // its interpreter ready once the driver is loaded.
  if (hardware.coral != null) {
    requirementsFiles.push('requirements-edgetpu.txt')
    backendIds.push('edgetpu')
  }
  return { requirementsFiles, backendIds }
}
