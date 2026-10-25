import * as os from 'node:os'
import * as fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errMsg, scoreRuntimes, enumerateInferenceDevices } from '@camstack/types'
import type {
  HardwareInfo,
  GpuInfo,
  NpuInfo,
  CoralInfo,
  PlatformCapabilities,
  IScopedLogger,
  AcceleratorCompute,
} from '@camstack/types'
import {
  type CoralDetection,
  type CoralFs,
  detectCoralAccelerator,
  nodeCoralFs,
} from './coral-accelerators.js'
import {
  type AcceleratorReprobe,
  coralSignature,
  diffInferenceDevices,
  withCoral,
} from './accelerator-reprobe.js'
import type { WindowsHardware, WindowsProbeRunner } from './windows-hardware.js'
import { probeWindowsHardware } from './windows-hardware.js'

/** WMI can be slow on a cold machine, but never worth stalling boot for. */
const WINDOWS_PROBE_TIMEOUT_MS = 15_000

/**
 * Promisified `execFile`. Used across the scorer so every subprocess
 * spawn yields the event loop — critical at boot because a single sync
 * spawn of a missing Python module hits its 30s timeout and freezes the
 * entire Node process (WS handshakes, tRPC subscriptions, metrics — all
 * stalled). Keeping it async turns the probe into a true background task.
 */
const execFileAsync = promisify(execFile)

/** Minimal no-op logger for default parameter */
const noopLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
  withTags() {
    return noopLogger
  },
}

/**
 * Get reliable "available" RAM in MB, cross-platform.
 * os.freemem() is unreliable on macOS (reports ~200MB on a 36GB system).
 * Uses systeminformation when available, falls back to native commands.
 */
async function getAvailableRAM_MB(): Promise<number> {
  try {
    const si = await import('systeminformation')
    const mem = await si.mem()
    return Math.round(mem.available / 1024 / 1024)
  } catch (err) {
    console.debug(
      `systeminformation not available, using platform-specific RAM probe: ${errMsg(err)}`,
    )
    const platform = os.platform()
    try {
      if (platform === 'darwin') {
        // Parse vm_stat: (free + inactive + purgeable) * pageSize
        const { stdout: output } = await execFileAsync('vm_stat', [], {
          encoding: 'utf8',
          timeout: 3000,
        })
        const pageSize = parseInt(output.match(/page size of (\d+)/)?.[1] ?? '16384')
        const free = parseInt(output.match(/Pages free:\s+(\d+)/)?.[1] ?? '0')
        const inactive = parseInt(output.match(/Pages inactive:\s+(\d+)/)?.[1] ?? '0')
        const purgeable = parseInt(output.match(/Pages purgeable:\s+(\d+)/)?.[1] ?? '0')
        return Math.round(((free + inactive + purgeable) * pageSize) / 1024 / 1024)
      } else if (platform === 'linux') {
        // Parse /proc/meminfo: MemAvailable
        const { readFileSync } = await import('node:fs')
        const meminfo = readFileSync('/proc/meminfo', 'utf8')
        const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/)
        if (match) return Math.round(parseInt(match[1]!) / 1024)
      }
    } catch (probeErr) {
      console.debug(`RAM probe failed, using total RAM fallback: ${errMsg(probeErr)}`)
    }
    // Ultimate fallback: total RAM (conservative but safe)
    return Math.round(os.totalmem() / 1024 / 1024)
  }
}

export class PlatformScorer {
  private cached: PlatformCapabilities | null = null
  private readonly logger: IScopedLogger
  /**
   * Path to the embedded portable Python (from `ctx.deps.ensurePython()`).
   * The Docker hub ships NO system `python3` — inference runs on the
   * downloaded portable build — so probing system `python3`/`python` would
   * wrongly report "Python not found". When set, the interpreter lookup
   * tries THIS binary first; `null` falls back to a system `python3`/`python`
   * lookup (dev / agent environments where Python is on PATH).
   */
  private readonly embeddedPythonPath: string | null
  /** Where the Coral scan reads `/sys` and `/dev` (the host's, unless a spec fakes one). */
  private readonly coralFs: CoralFs
  /**
   * Asks OpenVINO / WebGPU for compute (D930). Null in tests and when this
   * process has no embedded interpreter — the pool's published file is the
   * other way the same facts arrive.
   */
  private readonly readAcceleratorFacts:
    | (() => Promise<readonly AcceleratorCompute[] | null>)
    | null

  constructor(
    logger: IScopedLogger = noopLogger,
    embeddedPythonPath: string | null = null,
    coralFs: CoralFs = nodeCoralFs,
    readAcceleratorFacts: (() => Promise<readonly AcceleratorCompute[] | null>) | null = null,
  ) {
    this.logger = logger
    this.embeddedPythonPath = embeddedPythonPath
    this.coralFs = coralFs
    this.readAcceleratorFacts = readAcceleratorFacts
  }

  /**
   * Probe hardware + derive scores from pure rules and score all backend combos.
   *
   * An optional `onPhase` callback is invoked at each step so consumers
   * (e.g. the platform-probe addon) can emit live progress events on
   * the event bus. The callback takes a phase id + a typed payload; all
   * phases fire in strict order: `started` → `hardware` → `scored` → `done`.
   * On failure, `error` fires once with the exception. Cached after first call.
   *
   * Scores are hardware-driven only (no Python module import subprocess):
   * `scoreRuntimes` from `@camstack/types` is the single source of truth.
   */
  async probe(
    onPhase?: (phase: string, payload?: Record<string, unknown>) => void,
  ): Promise<PlatformCapabilities> {
    if (this.cached) return this.cached

    const start = Date.now()
    onPhase?.('started', {})
    this.logger.info('Probing hardware...')
    const hardware = await this.probeHardware()
    this.logger.info('Hardware detected', {
      meta: {
        platform: hardware.platform,
        arch: hardware.arch,
        cpuModel: hardware.cpuModel,
        cpuCores: hardware.cpuCores,
        ramGB: Math.round(hardware.totalRAM_MB / 1024),
      },
    })
    if (hardware.gpu) this.logger.info('GPU detected', { meta: { name: hardware.gpu.name } })
    if (hardware.npu) this.logger.info('NPU detected', { meta: { type: hardware.npu.type } })
    onPhase?.('hardware', { hardware })

    const { scores, best: bestScore } = scoreRuntimes(hardware)
    const pythonPath = await this.resolvePythonPath()

    if (pythonPath) {
      this.logger.info('Python interpreter located', { meta: { pythonPath } })
    } else {
      this.logger.info('Python: not found')
    }

    const elapsed = Date.now() - start
    this.logger.info('Scoring complete', {
      meta: { elapsedMs: elapsed, combos: scores.length },
    })
    this.logger.info('Best backend selected', {
      meta: {
        runtime: bestScore.runtime,
        backend: bestScore.backend,
        format: bestScore.format,
        reason: bestScore.reason,
        score: bestScore.score,
      },
    })
    for (const s of scores) {
      this.logger.debug('Score entry', {
        meta: {
          available: s.available,
          runtime: s.runtime,
          backend: s.backend,
          format: s.format,
          score: s.score,
          reason: s.reason,
        },
      })
    }

    this.cached = {
      hardware,
      scores: [...scores],
      bestScore,
      pythonPath,
      devices: enumerateInferenceDevices(hardware),
    }
    onPhase?.('scored', { scores, bestScore, elapsedMs: elapsed })
    onPhase?.('done', { capabilities: this.cached })
    return this.cached
  }

  async probeHardware(): Promise<HardwareInfo> {
    const platform = os.platform() as HardwareInfo['platform']
    const arch = os.arch() as HardwareInfo['arch']
    const cpus = os.cpus()
    const cpuModel = cpus[0]?.model ?? 'unknown'
    const cpuCores = cpus.length
    const totalRAM_MB = Math.round(os.totalmem() / 1024 / 1024)
    const availableRAM_MB = await getAvailableRAM_MB()
    this.logger.debug('RAM probed', { meta: { totalRAM_MB, availableRAM_MB } })

    let gpu: GpuInfo | null = null
    let npu: NpuInfo | null = null

    // Coral Edge TPU — USB and/or PCIe/M.2, independent of the host GPU/NPU.
    // Scanned on every platform (the hub is Linux; `/sys` USB + PCI + the apex
    // class, `/dev/apex_N`, or the installed libedgetpu delegate is the signal).
    const coral: CoralInfo | null = this.probeCoral().info

    // macOS Apple Silicon
    if (platform === 'darwin' && arch === 'arm64') {
      gpu = { type: 'apple', name: 'Apple Silicon GPU' }
      npu = { type: 'apple-ane' }
    }

    // Windows: GPU vendor/model and the AMD NPU come from WMI, never from /sys.
    // NVIDIA's own tool still gives the exact VRAM, so it runs first and wins.
    if (platform === 'win32') {
      const nvidia = await this.probeNvidiaSmi()
      const win = await this.probeWindowsHardwareSafely()
      gpu = nvidia ?? win.gpu
      npu = win.npu
      if (gpu)
        this.logger.info('Windows GPU detected', {
          meta: { type: gpu.type, name: gpu.name },
        })
      if (npu && win.source !== 'none')
        this.logger.info('AMD XDNA NPU detected (present only)', {
          meta: {
            type: npu.type,
            name: npu.name,
            generation: npu.generation,
            source: win.source,
          },
        })
    }

    // Linux NVIDIA
    if (platform === 'linux') {
      const nvidia = await this.probeNvidiaSmi()
      if (nvidia) gpu = nvidia

      const listRenderNodes = (): readonly string[] => {
        try {
          return fs
            .readdirSync('/dev/dri')
            .filter((n) => n.startsWith('renderD'))
            .map((n) => `/dev/dri/${n}`)
        } catch {
          return []
        }
      }
      const readDrmAttr = (node: string, attr: 'vendor' | 'device'): string => {
        try {
          return fs.readFileSync(`/sys/class/drm/${node.split('/').pop()}/device/${attr}`, 'utf8')
        } catch {
          return ''
        }
      }

      if (!gpu) {
        const { classifyIntelAccelerators } = await import('./intel-accelerators.js')
        const intel = classifyIntelAccelerators({
          listRenderNodes,
          readVendor: (node) => readDrmAttr(node, 'vendor'),
        })
        gpu = gpu ?? intel.gpu
        if (intel.gpu)
          this.logger.info('Intel iGPU detected', {
            meta: { name: intel.gpu.name },
          })
      }

      if (!gpu) {
        const { classifyAmdAccelerators } = await import('./amd-accelerators.js')
        const amd = classifyAmdAccelerators({
          listRenderNodes,
          readVendor: (node) => readDrmAttr(node, 'vendor'),
          readDevice: (node) => readDrmAttr(node, 'device'),
        })
        gpu = gpu ?? amd.gpu
        if (amd.gpu)
          this.logger.info('AMD iGPU detected', {
            meta: { name: amd.gpu.name },
          })
      }

      const listDir = (p: string): readonly string[] => {
        try {
          return fs.readdirSync(p)
        } catch {
          return []
        }
      }
      const exists = (p: string): boolean => fs.existsSync(p)

      // Intel NPU ("AI Boost", `intel_vpu`) — a separate DRM accel char device
      // (`/dev/accel/accel*`) from the iGPU. Never clobber an already-resolved
      // NPU (e.g. `apple-ane`); only set intel-npu on linux + x64 + Intel host.
      if (!npu) {
        const { classifyIntelNpu } = await import('./intel-npu.js')
        const intelPresent = gpu?.type === 'intel' || /intel/i.test(cpuModel)
        npu = classifyIntelNpu({ platform, arch, intelPresent }, { listDir, exists })
        if (npu)
          this.logger.info('Intel NPU detected', {
            meta: {
              type: npu.type,
              name: npu.name,
              device: '/dev/accel/accel*',
            },
          })
      }

      // AMD XDNA NPU — present-only until P2; do not offer as an inference device.
      if (!npu) {
        const { classifyAmdNpu } = await import('./amd-npu.js')
        const amdPresent = gpu?.type === 'amd' || /amd|ryzen/i.test(cpuModel)
        npu = classifyAmdNpu(
          { platform, arch, amdPresent },
          {
            listDir,
            exists,
            readFile: (p) => {
              try {
                return fs.readFileSync(p, 'utf8')
              } catch {
                return ''
              }
            },
          },
        )
        if (npu)
          this.logger.info('AMD XDNA NPU detected (present only)', {
            meta: {
              type: npu.type,
              name: npu.name,
              generation: npu.generation,
            },
          })
      }
    }

    const hardware: HardwareInfo = {
      platform,
      arch,
      cpuModel,
      cpuCores,
      totalRAM_MB,
      availableRAM_MB,
      gpu,
      npu,
      coral,
    }
    const accelerators = await this.readAcceleratorCompute()
    return accelerators === null ? hardware : { ...hardware, accelerators }
  }

  /** Compute facts, or null when the probe did not run or could not ask. */
  private async readAcceleratorCompute(): Promise<readonly AcceleratorCompute[] | null> {
    const read = this.readAcceleratorFacts
    if (read === null) return null
    try {
      const facts = await read()
      if (facts === null) return null
      this.logger.info('accelerator compute probed', {
        meta: { devices: facts.map((row) => row.deviceKey) },
      })
      return facts
    } catch (err) {
      this.logger.warn('accelerator compute probe failed', { meta: { error: errMsg(err) } })
      return null
    }
  }

  /**
   * The Coral part of the probe, with the evidence that decided it logged —
   * a node that reports a Coral, or stops reporting one, says WHY (D919).
   */
  private probeCoral(): CoralDetection {
    const detection = detectCoralAccelerator(this.coralFs)
    const coral = detection.info
    this.logger.info('Coral Edge TPU probe', {
      meta: {
        usbBus: detection.usbBus,
        decidedBy: detection.decidedBy,
        units: coral?.units ?? [],
        inaccessibleUsbNodes: detection.inaccessibleUsbNodes,
      },
    })
    if (coral) {
      if ((coral.units ?? []).length > 0)
        this.logger.info('Coral Edge TPU detected', {
          meta: { units: coral.units, decidedBy: detection.decidedBy },
        })
      // Present but unusable: say WHY, every probe — silence would read as "no Coral".
      for (const unavailable of coral.unavailable ?? [])
        this.logger.warn('Coral Edge TPU present but unusable', {
          meta: {
            bus: unavailable.bus,
            count: unavailable.count,
            reason: unavailable.reason,
            ...(unavailable.bus === 'usb' ? { nodes: detection.inaccessibleUsbNodes } : {}),
          },
        })
    }
    return detection
  }

  /**
   * Re-run ONLY the accelerator part (Coral USB ids + PCIe apex units: `/sys`
   * and `/dev` reads, no model load) against the cached probe, and rebuild the
   * device list from it when it changed. `null` before the first full probe
   * completed — there is nothing to compare against yet. Logs the evidence
   * only when the answer changed, so a 60 s cadence stays quiet.
   */
  reprobeAccelerators(): AcceleratorReprobe | null {
    const cached = this.cached
    if (cached === null) return null
    const detection = detectCoralAccelerator(this.coralFs)
    if (coralSignature(detection.info) === coralSignature(cached.hardware.coral)) {
      return {
        caps: cached,
        change: { appeared: [], disappeared: [] },
        detection,
      }
    }
    this.logger.info('Coral Edge TPU probe changed', {
      meta: {
        usbBus: detection.usbBus,
        decidedBy: detection.decidedBy,
        before: coralSignature(cached.hardware.coral),
        after: coralSignature(detection.info),
        inaccessibleUsbNodes: detection.inaccessibleUsbNodes,
      },
    })
    const next = withCoral(cached, detection.info)
    this.cached = next
    return {
      caps: next,
      change: diffInferenceDevices(cached.devices, next.devices),
      detection,
    }
  }

  /** NVIDIA's own tool: exact model and VRAM. Null when absent or failing. */
  private async probeNvidiaSmi(): Promise<GpuInfo | null> {
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader'],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        },
      )
      const output = stdout.trim()
      if (!output) return null
      const [name, mem] = output.split(',').map((s) => s.trim())
      return {
        type: 'nvidia',
        name: name ?? 'NVIDIA GPU',
        memoryMB: parseInt(mem ?? '0'),
      }
    } catch (err) {
      this.logger.debug('NVIDIA GPU detection failed', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  /** Windows WMI probe; bounded, and a failure is a log line, never a boot failure. */
  private async probeWindowsHardwareSafely(): Promise<WindowsHardware> {
    const run: WindowsProbeRunner = async (file, args) => {
      const { stdout } = await execFileAsync(file, [...args], {
        encoding: 'utf8',
        timeout: WINDOWS_PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      return stdout
    }
    const systemRoot = process.env['SystemRoot']
    try {
      return await probeWindowsHardware(run, {
        ...(systemRoot === undefined ? {} : { systemRoot }),
        onFallback: (reason) =>
          this.logger.warn('Windows hardware probe degraded', {
            meta: { reason },
          }),
      })
    } catch (err) {
      this.logger.warn('Windows hardware probe failed — scoring as a CPU node', {
        meta: { error: errMsg(err) },
      })
      return { gpu: null, npu: null, source: 'none' }
    }
  }

  /**
   * Locates a Python interpreter without importing any module.
   *
   * Tries: embedded path (if configured) → `python3` → `python`.
   * Returns the first executable found, or `null` if none respond.
   * MUST NOT run `-c "import ..."` — interpreter location only.
   */
  private async resolvePythonPath(): Promise<string | null> {
    const candidates: readonly string[] = [
      ...(this.embeddedPythonPath ? [this.embeddedPythonPath] : []),
      'python3',
      'python',
    ]
    for (const cmd of candidates) {
      try {
        await execFileAsync(cmd, ['--version'], { timeout: 5000 })
        return cmd
      } catch (err) {
        this.logger.debug(`Python command "${cmd}" not found`, {
          meta: { error: errMsg(err) },
        })
      }
    }
    return null
  }
}
