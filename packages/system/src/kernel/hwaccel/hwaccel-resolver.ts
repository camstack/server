/**
 * Platform-probe for hardware video decode acceleration.
 *
 * Returns an ordered preference list of backend names for the current
 * host. Consumers pick the first one their decoder library supports;
 * if every pick fails, they fall back to software.
 *
 * Backend names are stable identifiers used both:
 *   - as a `-hwaccel <name>` flag to the `ffmpeg` CLI
 *   - as a `FFHWDeviceType` constant name to `HardwareDeviceContext.create()`
 *     in the node-av native bindings.
 *
 * The two layers accept the same string set (`videotoolbox`, `cuda`,
 * `vaapi`, `qsv`, `d3d11va`, `dxva2`, `amf`, `vdpau`, `drm`) so a
 * single resolver drives both without a mapping layer.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import type {
  CoralInfo,
  HwAccelBackend,
  HwAccelResolution,
  IKernelHwAccel,
  IScopedLogger,
} from '@camstack/types'
import {
  classifyCoralAccelerator,
  nodeCoralFs,
} from '../../builtins/platform-probe/coral-accelerators.js'
import { probeVaapiInit, type VaapiInitStatus } from './vaapi-init-probe.js'

export interface PlatformSignals {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly hasNvidiaGpu: boolean
  readonly hasAmdGpu: boolean
  readonly hasIntelGpu: boolean
  readonly hasRenderNode: boolean
  /** Intel NPU (Meteor Lake / Core Ultra "AI Boost") — exposed as /dev/accel/accel0. */
  readonly hasIntelNpu: boolean
  /**
   * Coral Edge TPU hardware (USB and/or PCIe), whole — usable units and the
   * present-but-unusable ones with their reason. `null` ⇒ no Coral found. The
   * SAME classifier as the platform-probe builtin, so the two never disagree.
   */
  readonly coral: CoralInfo | null
}

function safeExistsSync(path: string): boolean {
  try {
    return fs.existsSync(path)
  } catch {
    return false
  }
}

/** Probe Linux GPU vendors by parsing /proc/bus/pci/devices or /sys/class/drm. */
function probeLinuxGpus(): Pick<
  PlatformSignals,
  'hasNvidiaGpu' | 'hasAmdGpu' | 'hasIntelGpu' | 'hasRenderNode' | 'hasIntelNpu' | 'coral'
> {
  const signals = {
    hasNvidiaGpu: false,
    hasAmdGpu: false,
    hasIntelGpu: false,
    hasRenderNode: false,
    // Intel NPU driver (intel_vpu) exposes an accel device node when loaded.
    hasIntelNpu: safeExistsSync('/dev/accel/accel0'),
    coral: classifyCoralAccelerator(nodeCoralFs),
  }
  // Render node presence is the baseline — without it, VAAPI can't open a device.
  signals.hasRenderNode = safeExistsSync('/dev/dri/renderD128')
  // NVIDIA driver exposes /dev/nvidia0 when loaded.
  if (safeExistsSync('/dev/nvidia0') || safeExistsSync('/proc/driver/nvidia/version')) {
    signals.hasNvidiaGpu = true
  }
  // Vendor id probe via /sys/class/drm — cheap and doesn't require root.
  try {
    const drmDir = '/sys/class/drm'
    if (fs.existsSync(drmDir)) {
      for (const entry of fs.readdirSync(drmDir)) {
        if (!entry.startsWith('card')) continue
        const vendorPath = `${drmDir}/${entry}/device/vendor`
        if (!safeExistsSync(vendorPath)) continue
        const vendor = fs.readFileSync(vendorPath, 'utf8').trim().toLowerCase()
        // PCI vendor ids — 0x10de NVIDIA, 0x1002 AMD, 0x8086 Intel
        if (vendor === '0x10de') signals.hasNvidiaGpu = true
        else if (vendor === '0x1002') signals.hasAmdGpu = true
        else if (vendor === '0x8086') signals.hasIntelGpu = true
      }
    }
  } catch {
    /* fall through — no extra signals */
  }
  return signals
}

export function probePlatform(): PlatformSignals {
  const platform = os.platform()
  const arch = os.arch()
  if (platform === 'linux') {
    return { platform, arch, ...probeLinuxGpus() }
  }
  return {
    platform,
    arch,
    hasNvidiaGpu: false,
    hasAmdGpu: false,
    hasIntelGpu: false,
    hasRenderNode: false,
    hasIntelNpu: false,
    // A Coral USB Edge TPU is reachable on non-Linux hosts too (macOS dev): no
    // `/sys` there, so the classifier answers from the installed delegate alone.
    coral: classifyCoralAccelerator(nodeCoralFs),
  }
}

/** The backends that open their device through libva on Linux. */
const LIBVA_BACKENDS: readonly HwAccelBackend[] = ['vaapi', 'qsv']

/**
 * The preference list for these signals. A `vaapi` verdict of `init-failed`
 * (libva cannot initialise the driver — D926) removes every libva-backed
 * backend and names the cause in the rationale; `ok`, `unknown` or `null`
 * change nothing.
 */
export function pickBackendsForPlatform(
  signals: PlatformSignals,
  vaapi: VaapiInitStatus | null = null,
): HwAccelResolution {
  const res = pickBackendsFromSignals(signals)
  if (signals.platform !== 'linux' || vaapi?.state !== 'init-failed') return res
  return {
    preferred: res.preferred.filter((b) => !LIBVA_BACKENDS.includes(b)),
    rationale: `${res.rationale} ${vaapi.summary} — vaapi/qsv withheld, decode runs in software.`,
  }
}

function pickBackendsFromSignals(signals: PlatformSignals): HwAccelResolution {
  switch (signals.platform) {
    case 'darwin': {
      return {
        preferred: ['videotoolbox'],
        rationale: `macOS (${signals.arch}) — VideoToolbox available on all Apple Silicon and Intel Macs.`,
      }
    }
    case 'linux': {
      const list: HwAccelBackend[] = []
      if (signals.hasNvidiaGpu) list.push('cuda', 'nvdec')
      if (signals.hasIntelGpu) list.push('qsv', 'vaapi')
      if (signals.hasAmdGpu) list.push('vaapi')
      // Fallback: if a render node exists but no vendor signal, try vaapi blindly.
      if (list.length === 0 && signals.hasRenderNode) list.push('vaapi')
      const reasons: string[] = []
      if (signals.hasNvidiaGpu) reasons.push('NVIDIA GPU detected')
      if (signals.hasIntelGpu) reasons.push('Intel GPU detected')
      if (signals.hasAmdGpu) reasons.push('AMD GPU detected')
      if (reasons.length === 0 && signals.hasRenderNode)
        reasons.push('render node present, vendor unknown')
      if (reasons.length === 0) reasons.push('no GPU signals')
      return {
        preferred: list,
        rationale: `Linux (${signals.arch}) — ${reasons.join(', ')}.`,
      }
    }
    case 'win32': {
      const list: HwAccelBackend[] = ['d3d11va', 'dxva2']
      if (signals.hasNvidiaGpu) list.unshift('cuda')
      if (signals.hasAmdGpu) list.unshift('amf')
      if (signals.hasIntelGpu) list.unshift('qsv')
      return {
        preferred: list,
        rationale: `Windows (${signals.arch}) — D3D11VA/DXVA2 always available; vendor-specific prepended when detected.`,
      }
    }
    default:
      return { preferred: [], rationale: `Unsupported platform: ${signals.platform}` }
  }
}

/**
 * Resolve the preferred hardware acceleration backend order for the
 * current host.
 *
 * An explicit `prefer` override — typically read from
 * `system-config.hwaccel.prefer` — wins unconditionally: the caller
 * stays on that single backend and falls back to software only if it
 * fails at decoder init.
 *
 * When no override is set, platform signals drive the order.
 */
export function resolveHwAccel(prefer?: HwAccelBackend | 'none' | null): HwAccelResolution {
  if (prefer === 'none') {
    return { preferred: [], rationale: 'Explicit override: hwaccel disabled.' }
  }
  if (prefer && prefer !== null && prefer.length > 0) {
    return { preferred: [prefer], rationale: `Explicit override: ${prefer}.` }
  }
  const signals = probePlatform()
  return pickBackendsForPlatform(signals)
}

const RENDER_NODE = '/dev/dri/renderD128'

/** Process-wide: the VA init failure is logged once per process, not per resolver. */
const PROCESS_VAAPI_REPORT: VaapiReportOnce = { reported: false }

/** Process-wide: hub-main builds one resolver per in-process addon; vainfo runs once. */
const PROCESS_VAAPI_PROBES = new Map<string, Promise<VaapiInitStatus>>()

function probeVaapiOncePerProcess(renderNode: string): Promise<VaapiInitStatus> {
  const known = PROCESS_VAAPI_PROBES.get(renderNode)
  if (known) return known
  const probe = probeVaapiInit(renderNode)
  PROCESS_VAAPI_PROBES.set(renderNode, probe)
  return probe
}

export interface VaapiReportOnce {
  reported: boolean
}

export interface KernelHwAccelOptions {
  /** Where the one ERROR line about a VA driver libva cannot load goes. */
  readonly logger?: IScopedLogger
  /** Test seams; default to the real host probes. */
  readonly probeSignals?: () => PlatformSignals
  readonly probeVaapi?: (renderNode: string) => Promise<VaapiInitStatus>
  readonly reportOnce?: VaapiReportOnce
}

/**
 * Build the `IKernelHwAccel` provider used to populate `ctx.kernel.hwaccel`.
 * An auto resolve on a Linux host with a render node asks libva ONCE per
 * provider whether it can initialise the driver (D926); an explicit override
 * is never second-guessed.
 */
export function createKernelHwAccel(options: KernelHwAccelOptions = {}): IKernelHwAccel {
  const probeSignals = options.probeSignals ?? probePlatform
  const probeVaapi = options.probeVaapi ?? probeVaapiOncePerProcess
  const reportOnce = options.reportOnce ?? PROCESS_VAAPI_REPORT
  let vaapi: Promise<VaapiInitStatus> | null = null
  const vaapiVerdict = async (): Promise<VaapiInitStatus> => {
    if (vaapi === null) vaapi = probeVaapi(RENDER_NODE)
    const status = await vaapi
    if (status.state === 'init-failed' && !reportOnce.reported) {
      reportOnce.reported = true
      options.logger?.error(
        `hwaccel: ${status.summary} — vaapi/qsv withheld, decode runs in software`,
        {
          meta: {
            renderNode: RENDER_NODE,
            vaApiVersion: status.vaApiVersion,
            driverPath: status.driverPath,
            driverNeedsVaApi: status.driverNeedsVaApi,
          },
        },
      )
    }
    return status
  }
  return {
    resolve: async (prefer) => {
      if (prefer === 'none' || (prefer !== null && prefer !== undefined && prefer.length > 0)) {
        return resolveHwAccel(prefer)
      }
      const signals = probeSignals()
      if (signals.platform !== 'linux' || !signals.hasRenderNode) {
        return pickBackendsForPlatform(signals)
      }
      return pickBackendsForPlatform(signals, await vaapiVerdict())
    },
  }
}
