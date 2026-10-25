/**
 * Hardware-driven inference runtime capabilities — SINGLE SOURCE OF TRUTH.
 *
 * Pure module: no I/O, no subprocess, no Python import.
 * Consumed by both `platform-probe` (@camstack/system) and
 * `detection-pipeline` (@camstack/addon-pipeline).
 *
 * Do NOT import from @camstack/system or @camstack/addon-pipeline.
 */

import type { ModelFormat } from '../types/models.js'
import type { HardwareInfo, PlatformScore } from '../interfaces/platform.js'
import { formatForRuntime } from '../utils/runtime-mapping.js'
import { coralUsableUnits, type CoralUnitAddress } from './coral-units.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RuntimeId = 'onnx' | 'openvino' | 'coreml' | 'edgetpu'

export interface DeviceOption {
  readonly value: string
  readonly label: string
}

export interface InferenceDeviceDescriptor {
  /** Stable per-node device id, e.g. `openvino:gpu`, `edgetpu:usb`, `cpu`. */
  readonly key: string
  readonly backend: string
  readonly device: string
  readonly format: ModelFormat
  readonly runtime: 'python'
  readonly score: number
  readonly available: boolean
}

// ---------------------------------------------------------------------------
// Internal runtime definitions (mirrors runtimes.ts structure)
// ---------------------------------------------------------------------------

const AUTO: DeviceOption = { value: 'auto', label: 'Auto' }
const CPU: DeviceOption = { value: 'cpu', label: 'CPU' }
const USB: DeviceOption = { value: 'usb', label: 'Coral USB' }

function coralUnitOption(unit: CoralUnitAddress): DeviceOption {
  const bus = unit.bus === 'pci' ? 'PCIe' : 'USB'
  const label = unit.index === 0 ? `Coral ${bus}` : `Coral ${bus} ${unit.index + 1}`
  return { value: unit.device, label }
}

interface RuntimeDef {
  readonly id: RuntimeId
  readonly supports: (hw: HardwareInfo | null) => boolean
  readonly devices: (hw: HardwareInfo | null) => readonly DeviceOption[]
  readonly defaultDevice: string
}

const ONNX_DEF: RuntimeDef = {
  id: 'onnx',
  supports: () => true,
  devices: (hw) => {
    if (!hw) return [CPU]
    const out: DeviceOption[] = [CPU]
    if (hw.gpu?.type === 'nvidia') out.push({ value: 'cuda', label: 'CUDA' })
    // The WebGPU EP package is installed on Linux only; Windows gets it with its own
    // device key after the NPU spike, so it is not offered there yet.
    if (hw.gpu?.type === 'amd' && hw.platform === 'linux')
      out.push({ value: 'webgpu', label: 'WebGPU (AMD iGPU)' })
    if (hw.npu?.type === 'apple-ane') out.push({ value: 'coreml', label: 'CoreML EP' })
    return out
  },
  defaultDevice: 'cpu',
}

const OPENVINO_DEF: RuntimeDef = {
  id: 'openvino',
  // x86_64 Linux: Intel iGPU/NPU, or AMD (CPU device only — int8 IRs on Zen4 VNNI).
  // Probe null on x86 → cannot prove a supported GPU → withhold (onnx floor remains).
  supports: (hw) =>
    hw?.arch === 'x64' &&
    hw.platform !== 'darwin' &&
    (hw.gpu?.type === 'intel' || hw.gpu?.type === 'amd'),
  devices: (hw) => {
    if (!hw) return [AUTO]
    if (hw.gpu?.type === 'amd') return [CPU]
    const out: DeviceOption[] = [AUTO, CPU]
    if (hw.gpu?.type === 'intel') out.push({ value: 'gpu', label: 'GPU' })
    if (hw.npu?.type === 'intel-npu') out.push({ value: 'npu', label: 'NPU' })
    return out
  },
  defaultDevice: 'auto',
}

const COREML_DEF: RuntimeDef = {
  id: 'coreml',
  supports: (hw) => hw?.platform === 'darwin',
  devices: (hw) => {
    const all: DeviceOption = { value: 'all', label: 'All (ANE + GPU + CPU)' }
    if (!hw) return [all]
    const out: DeviceOption[] = [all]
    if (hw.npu?.type === 'apple-ane') out.push({ value: 'ane', label: 'Apple Neural Engine' })
    out.push({ value: 'gpu', label: 'GPU' }, CPU)
    return out
  },
  defaultDevice: 'all',
}

const EDGETPU_DEF: RuntimeDef = {
  id: 'edgetpu',
  // Coral Edge TPU, USB and/or PCIe. The offer is gated on a USABLE unit — a
  // Coral whose driver is missing or whose device node cannot be opened is
  // reported by the probe but never offered (the libedgetpu delegate + tflite
  // model are provisioned on demand, same policy as openvino's packages).
  supports: (hw) => coralUsableUnits(hw?.coral).length > 0,
  devices: (hw) => {
    const units = coralUsableUnits(hw?.coral)
    return units.length > 0 ? units.map(coralUnitOption) : [USB]
  },
  defaultDevice: 'usb',
}

// Order is the offer order: floor first, accelerators after.
const RUNTIMES: readonly RuntimeDef[] = [ONNX_DEF, OPENVINO_DEF, COREML_DEF, EDGETPU_DEF]

function def(id: RuntimeId): RuntimeDef {
  const d = RUNTIMES.find((r) => r.id === id)
  if (!d) throw new Error(`Unknown runtime: ${id}`)
  return d
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the list of supported runtime IDs for given hardware.
 * onnx is always included (universal floor); accelerators added when hw matches.
 */
export function supportedRuntimes(hw: HardwareInfo | null): readonly RuntimeId[] {
  return RUNTIMES.filter((r) => r.supports(hw)).map((r) => r.id)
}

/**
 * Returns the device options for a given runtime and hardware probe.
 */
export function runtimeDevices(id: RuntimeId, hw: HardwareInfo | null): readonly DeviceOption[] {
  return def(id).devices(hw)
}

/**
 * Returns the default device string for a given runtime.
 * onnx → 'cpu', openvino → 'auto', coreml → 'all'
 */
export function defaultDeviceFor(id: RuntimeId): string {
  return def(id).defaultDevice
}

/**
 * Returns the model format required for a given runtime.
 * Delegates to `formatForRuntime` from runtime-mapping.ts.
 */
export function modelFormatForRuntime(id: RuntimeId): ModelFormat {
  // `edgetpu` maps to the full-integer tflite build; the shared
  // `formatForRuntime` map is keyed by DetectionRuntime and handles the rest.
  if (id === 'edgetpu') return 'tflite'
  return formatForRuntime(id)
}

// ---------------------------------------------------------------------------
// scoreRuntimes result type
// ---------------------------------------------------------------------------

interface ScoreRuntimesResult {
  readonly scores: readonly PlatformScore[]
  readonly best: PlatformScore
}

/**
 * Scores all applicable inference backends for the given hardware.
 *
 * Rules (hardware-driven only — no Python import probes):
 * - coreml:   score 95, darwin+arm64
 * - cuda:     score 85, nvidia gpu
 * - openvino: score 90 if intel-npu present, else 80 if intel gpu
 * - edgetpu:  score 70, a usable Coral unit (USB or PCIe)
 * - cpu:      score 50 (universal floor, always included)
 *
 * All hardware-matched entries are `available: true`.
 * Scores are sorted descending; `best` is the first available entry
 * (or last entry as fallback).
 */
export function scoreRuntimes(hw: HardwareInfo): ScoreRuntimesResult {
  const scores: PlatformScore[] = []

  // macOS Apple Silicon — CoreML
  if (hw.platform === 'darwin' && hw.arch === 'arm64') {
    scores.push({
      runtime: 'python',
      backend: 'coreml',
      format: 'coreml',
      score: 95,
      reason: 'Apple Neural Engine (Python CoreML)',
      available: true,
    })
  }

  // NVIDIA CUDA
  if (hw.gpu?.type === 'nvidia') {
    scores.push({
      runtime: 'python',
      backend: 'cuda',
      format: 'onnx',
      score: 85,
      reason: 'NVIDIA CUDA (Python ONNX Runtime)',
      available: true,
    })
  }

  // Intel OpenVINO — hardware-driven (available:true when intel gpu present)
  if (hw.gpu?.type === 'intel') {
    const score = hw.npu?.type === 'intel-npu' ? 90 : 80
    scores.push({
      runtime: 'python',
      backend: 'openvino',
      format: 'openvino',
      score,
      reason: 'Intel OpenVINO',
      available: true,
    })
  }

  // AMD iGPU via ONNX Runtime WebGPU EP (P1). Above OV-CPU, below Intel OV iGPU.
  // Linux only: the plugin is provisioned there (`runtime-packages.ts`); scoring it
  // on Windows would make an uninstalled backend the node's best.
  if (hw.gpu?.type === 'amd') {
    if (hw.platform === 'linux') {
      scores.push({
        runtime: 'python',
        backend: 'onnx',
        format: 'onnx',
        score: 75,
        reason: 'ONNX WebGPU (AMD iGPU)',
        available: true,
      })
    }
    // OpenVINO CPU — int8 IRs on Zen4 AVX-512 VNNI. Below WebGPU, above onnx cpu.
    scores.push({
      runtime: 'python',
      backend: 'openvino',
      format: 'openvino',
      score: 65,
      reason: 'OpenVINO CPU (AMD x64)',
      available: true,
    })
  }

  // Coral Edge TPU — discrete USB/PCIe accelerator, coexists with the host
  // GPU/NPU. Scored below GPU-class OpenVINO (80/90) and above the CPU floor (50).
  if (coralUsableUnits(hw.coral).length > 0) {
    scores.push({
      runtime: 'python',
      backend: 'edgetpu',
      format: 'tflite',
      score: 70,
      reason: 'Coral Edge TPU (Python LiteRT)',
      available: true,
    })
  }

  // Universal CPU floor — always present
  scores.push({
    runtime: 'python',
    backend: 'cpu',
    format: 'onnx',
    score: 50,
    reason: 'CPU (Python ONNX Runtime)',
    available: true,
  })

  const sorted = scores.toSorted((a, b) => b.score - a.score)
  const best = sorted.find((s) => s.available) ?? sorted[sorted.length - 1]!

  return { scores: sorted, best }
}

const DEVICE_FOR_BACKEND: Readonly<Record<string, string>> = {
  cuda: 'gpu',
  edgetpu: 'usb',
  coreml: 'all',
  cpu: 'cpu',
}

function device(
  backend: string,
  dev: string,
  format: ModelFormat,
  score: number,
): InferenceDeviceDescriptor {
  return {
    key: backend === 'cpu' ? 'cpu' : `${backend}:${dev}`,
    backend,
    device: dev,
    format,
    runtime: 'python',
    score,
    available: true,
  }
}

/**
 * Enumerate every usable inference device on a node — one descriptor PER PHYSICAL
 * ACCELERATOR, so the orchestrator can run and balance across all of them
 * CONCURRENTLY (each device is its own pool). Critically, OpenVINO is expanded
 * into its distinct devices (NPU / iGPU / CPU) rather than a single AUTO entry:
 * the Intel NPU ("AI Boost") and the iGPU are separate accelerators and run in
 * parallel — collapsing them to AUTO would leave one idle. NPU is scored above
 * the iGPU (faster for int8 detection AND frees the GPU).
 */
export function enumerateInferenceDevices(hw: HardwareInfo): readonly InferenceDeviceDescriptor[] {
  const { scores } = scoreRuntimes(hw)
  const out: InferenceDeviceDescriptor[] = []
  for (const s of scores) {
    if (s.backend === 'openvino') {
      // Expand into the distinct HW accelerators only. On Intel, CPU is
      // intentionally NOT emitted as `openvino:cpu` — the universal `cpu`
      // floor already covers it; emitting both would oversubscribe one CPU.
      // On AMD there is no GPU/NPU OpenVINO device yet, so `openvino:cpu` is
      // the only way to serve the int8 IR format (onnx floor is a different format).
      if (hw.npu?.type === 'intel-npu') out.push(device('openvino', 'npu', s.format, s.score + 2))
      if (hw.gpu?.type === 'intel') out.push(device('openvino', 'gpu', s.format, s.score))
      if (hw.gpu?.type === 'amd') out.push(device('openvino', 'cpu', s.format, s.score))
      continue
    }
    if (s.backend === 'edgetpu') {
      // One descriptor PER usable Coral unit, USB then PCIe, so every Edge TPU
      // gets its own pool and they run CONCURRENTLY. The first unit of a bus
      // keeps the bare bus key (`edgetpu:usb`, `edgetpu:pci`), further units
      // are ordinal (`edgetpu:usb:1`, `edgetpu:pci:1`). The pool opens the
      // delegate on the explicit ordinal (`edgetpuDelegateDevice`: `usb:0`,
      // `pci:1`, …). Present-but-unusable units are never enumerated.
      for (const unit of coralUsableUnits(hw.coral)) {
        out.push(device('edgetpu', unit.device, s.format, s.score))
      }
      continue
    }
    // AMD WebGPU — scoreRuntimes emits backend `onnx` with reason ONNX WebGPU.
    if (s.backend === 'onnx' && s.reason.startsWith('ONNX WebGPU')) {
      out.push(device('onnx', 'webgpu', s.format, s.score))
      continue
    }
    const dev = DEVICE_FOR_BACKEND[s.backend] ?? s.backend
    out.push(device(s.backend, dev, s.format, s.score))
  }
  return out
}
