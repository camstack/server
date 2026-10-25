import type { NpuInfo } from '@camstack/types'

/**
 * Filesystem seam for AMD XDNA NPU detection. Sysfs under
 * /sys/class/accel/accelN/device/{vendor,device} names the PCI ids; the
 * char device is /dev/accel/accelN.
 */
export interface AmdNpuFs {
  listDir(path: string): readonly string[]
  exists(path: string): boolean
  /** Read a sysfs attribute; empty string when missing. */
  readFile(path: string): string
}

export interface AmdNpuContext {
  readonly platform: 'darwin' | 'linux' | 'win32'
  readonly arch: 'arm64' | 'x64'
  /**
   * True when an AMD CPU or AMD iGPU is present. A stray accel node on a
   * non-AMD host must not be reported as XDNA.
   */
  readonly amdPresent: boolean
}

const ACCEL_CLASS = '/sys/class/accel'
const ACCEL_DEV = '/dev/accel'
const AMD_PCI_VENDOR = '0x1022'

/** Phoenix / Hawk Point XDNA1. */
const XDNA1_DEVICES: ReadonlySet<string> = new Set(['0x1502'])
/** Strix / Krackan XDNA2. */
const XDNA2_DEVICES: ReadonlySet<string> = new Set(['0x17f0'])

function normalizePciId(raw: string): string {
  const t = raw.trim().toLowerCase()
  if (t.startsWith('0x')) return t
  // Hex digits without the 0x prefix (sysfs sometimes omits it).
  if (t.length > 0 && [...t].every((c) => '0123456789abcdef'.includes(c))) return '0x' + t
  return t
}

function hasAccelCharDevice(fsx: AmdNpuFs): boolean {
  if (fsx.listDir(ACCEL_DEV).some((n) => n.startsWith('accel'))) return true
  return fsx.exists(ACCEL_DEV + '/accel0')
}

/**
 * Detect an AMD XDNA NPU and report it as **present only**.
 *
 * Inference is NOT offered until P2 (Ryzen AI on Linux is Strix-first;
 * Phoenix is not a production path today). The probe still names the
 * generation so the UI and fleet census can show the hardware.
 */
export function classifyAmdNpu(ctx: AmdNpuContext, fsx: AmdNpuFs): NpuInfo | null {
  if (ctx.platform !== 'linux' || ctx.arch !== 'x64' || !ctx.amdPresent) return null
  if (!hasAccelCharDevice(fsx)) return null

  for (const name of fsx.listDir(ACCEL_CLASS)) {
    if (!name.startsWith('accel')) continue
    const vendor = normalizePciId(fsx.readFile(ACCEL_CLASS + '/' + name + '/device/vendor'))
    const device = normalizePciId(fsx.readFile(ACCEL_CLASS + '/' + name + '/device/device'))
    if (vendor !== AMD_PCI_VENDOR) continue
    return xdnaInfoForDevice(device)
  }
  return null
}

/**
 * The NPU descriptor for an AMD PCI device id (`0x1502` or `1502`). Shared by
 * the Linux sysfs probe and the Windows PnP probe so both name the same
 * silicon the same way.
 */
export function xdnaInfoForDevice(rawDeviceId: string): NpuInfo {
  const device = normalizePciId(rawDeviceId)
  if (XDNA1_DEVICES.has(device)) {
    return { type: 'amd-xdna', name: 'AMD XDNA1 NPU', generation: 'xdna1' }
  }
  if (XDNA2_DEVICES.has(device)) {
    return { type: 'amd-xdna', name: 'AMD XDNA2 NPU', generation: 'xdna2' }
  }
  // AMD accel with an unknown device id — still XDNA-class on this host.
  return { type: 'amd-xdna', name: 'AMD XDNA NPU' }
}
