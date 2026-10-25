import type { GpuInfo, NpuInfo } from '@camstack/types'
import { xdnaInfoForDevice } from './amd-npu.js'

/**
 * Windows hardware probe — the same `hw.gpu` / `hw.npu` model the Linux probe
 * fills from `/sys` and `/dev`, read from WMI instead.
 *
 * Two sources, tried in order, neither able to block boot:
 *   1. PowerShell + `Get-CimInstance` (every supported Windows ships it; one
 *      process answers both questions).
 *   2. `wmic` — deprecated and absent from newer images, but present on the
 *      Windows 10/11 releases that lack nothing else, and the only thing left
 *      when PowerShell is locked down by policy.
 *
 * Everything here is PURE over the text a runner returns, so the parsing and
 * the classification are tested on any OS. What this cannot prove — and a
 * Mac cannot — is the shape of the real WMI output on a real Windows host; the
 * parsers are written to accept both the object and the array form PowerShell
 * produces, and the wmic CSV header order wmic actually uses.
 */

/** Runs a program and resolves with its stdout; rejects on failure or timeout. */
export type WindowsProbeRunner = (file: string, args: readonly string[]) => Promise<string>

export interface WindowsVideoController {
  readonly name: string
  readonly pnpDeviceId: string
}

export interface WindowsPnpDevice {
  readonly name: string
  readonly pnpDeviceId: string
}

export interface WindowsHardware {
  readonly gpu: GpuInfo | null
  readonly npu: NpuInfo | null
  /** Which source answered — for the boot log; `none` when neither could. */
  readonly source: 'powershell' | 'wmic' | 'none'
}

const PCI_VENDOR_NVIDIA = '10DE'
const PCI_VENDOR_INTEL = '8086'
/** Radeon graphics are 1002; the XDNA NPU is a 1022 device. */
const PCI_VENDORS_AMD: ReadonlySet<string> = new Set(['1002', '1022'])

/** Adapters that are not hardware: RDP, hypervisor, capture and spoofing drivers. */
const VIRTUAL_ADAPTER =
  /basic display|basic render|remote display|hyper-v|vmware|virtualbox|parallels|citrix|parsec|indirect display|displaylink|mirror driver|virtual/i

/** One PowerShell process answers both: video controllers and AMD PCI devices. */
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, PNPDeviceID)',
  "$npu = @(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -match 'VEN_1022&DEV_(1502|17F0)' } | Select-Object Name, PNPDeviceID)",
  '@{ gpu = $gpu; npu = $npu } | ConvertTo-Json -Compress -Depth 3',
].join('; ')

export function powershellInvocation(
  systemRoot: string | undefined,
): readonly [string, readonly string[]] {
  const root = systemRoot ?? 'C:\\Windows'
  return [
    `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT],
  ]
}

export const WMIC_VIDEO_ARGS: readonly string[] = [
  'path',
  'Win32_VideoController',
  'get',
  'Name,PNPDeviceID',
  '/format:csv',
]

export const WMIC_AMD_PNP_ARGS: readonly string[] = [
  'path',
  'Win32_PnPEntity',
  'where',
  "PNPDeviceID like 'PCI\\\\VEN_1022&DEV_%'",
  'get',
  'Name,PNPDeviceID',
  '/format:csv',
]

function asRecordList(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
    )
  }
  return value !== null && typeof value === 'object'
    ? [Object.fromEntries(Object.entries(value))]
    : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** PowerShell prepends a BOM on some hosts, which `JSON.parse` rejects. */
function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, '').trim())
}

export interface ParsedPowershell {
  readonly controllers: readonly WindowsVideoController[]
  readonly pnp: readonly WindowsPnpDevice[]
}

/**
 * `{"gpu":[...],"npu":[...]}` as the script emits it. A single result comes
 * back as an object rather than a one-element array, and an empty one as
 * `null` — all three are handled.
 */
export function parsePowershellOutput(text: string): ParsedPowershell {
  const root = parseJson(text)
  const gpu = root !== null && typeof root === 'object' ? Reflect.get(root, 'gpu') : undefined
  const npu = root !== null && typeof root === 'object' ? Reflect.get(root, 'npu') : undefined
  const toDevice = (r: Record<string, unknown>): WindowsPnpDevice => ({
    name: str(r['Name']),
    pnpDeviceId: str(r['PNPDeviceID']),
  })
  return {
    controllers: asRecordList(gpu).map(toDevice),
    pnp: asRecordList(npu).map(toDevice),
  }
}

/**
 * `wmic ... /format:csv` — a blank line, then `Node,<cols alphabetical>`, then
 * one row per object. The device name can contain commas, so only the FIRST
 * column boundaries are trusted: columns after `Node` are `Name,PNPDeviceID`
 * and the PNP id (no commas) is taken from the END of the row.
 */
export function parseWmicCsv(text: string): readonly WindowsPnpDevice[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const headerIndex = lines.findIndex((l) => /^node,/i.test(l))
  if (headerIndex < 0) return []
  const out: WindowsPnpDevice[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    const parts = line.split(',')
    if (parts.length < 3) continue
    const pnpDeviceId = (parts[parts.length - 1] ?? '').trim()
    const name = parts.slice(1, -1).join(',').trim()
    if (pnpDeviceId.length > 0) out.push({ name, pnpDeviceId })
  }
  return out
}

/** The PCI vendor id (`10DE`) out of a PnP id like `PCI\VEN_10DE&DEV_2504&...`. */
export function pciVendorOf(pnpDeviceId: string): string | null {
  const m = /VEN_([0-9A-F]{4})/i.exec(pnpDeviceId)
  return m?.[1] ? m[1].toUpperCase() : null
}

function pciDeviceOf(pnpDeviceId: string): string | null {
  const m = /DEV_([0-9A-F]{4})/i.exec(pnpDeviceId)
  return m?.[1] ? m[1].toLowerCase() : null
}

type GpuVendor = GpuInfo['type']

function gpuVendor(c: WindowsVideoController): GpuVendor | null {
  const vendor = pciVendorOf(c.pnpDeviceId)
  if (vendor === PCI_VENDOR_NVIDIA) return 'nvidia'
  if (vendor === PCI_VENDOR_INTEL) return 'intel'
  if (vendor !== null && PCI_VENDORS_AMD.has(vendor)) return 'amd'
  if (/nvidia|geforce|quadro|rtx/i.test(c.name)) return 'nvidia'
  if (/intel/i.test(c.name)) return 'intel'
  if (/amd|radeon/i.test(c.name)) return 'amd'
  return null
}

/**
 * The accelerator the node should treat as its GPU. Same preference as the
 * Linux probe — NVIDIA, then Intel, then AMD — so a laptop with an Intel iGPU
 * and a discrete card is described the way the rest of the system already
 * expects. Virtual adapters never count.
 */
export function classifyWindowsGpu(controllers: readonly WindowsVideoController[]): GpuInfo | null {
  const real = controllers.filter((c) => c.name.length > 0 && !VIRTUAL_ADAPTER.test(c.name))
  for (const wanted of ['nvidia', 'intel', 'amd'] as const) {
    const hit = real.find((c) => gpuVendor(c) === wanted)
    if (hit) return { type: wanted, name: hit.name }
  }
  return null
}

/**
 * An AMD XDNA NPU from PnP ids: `PCI\VEN_1022&DEV_1502` (Phoenix / Hawk Point)
 * or `DEV_17F0` (Strix / Krackan). Present-only, exactly like the Linux probe.
 */
export function classifyWindowsAmdNpu(devices: readonly WindowsPnpDevice[]): NpuInfo | null {
  for (const d of devices) {
    if (pciVendorOf(d.pnpDeviceId) !== '1022') continue
    const device = pciDeviceOf(d.pnpDeviceId)
    if (device === '1502' || device === '17f0') return xdnaInfoForDevice(device)
  }
  return null
}

async function viaPowershell(
  run: WindowsProbeRunner,
  systemRoot: string | undefined,
): Promise<WindowsHardware> {
  const [file, args] = powershellInvocation(systemRoot)
  const parsed = parsePowershellOutput(await run(file, args))
  return {
    gpu: classifyWindowsGpu(parsed.controllers),
    npu: classifyWindowsAmdNpu(parsed.pnp),
    source: 'powershell',
  }
}

async function viaWmic(run: WindowsProbeRunner): Promise<WindowsHardware> {
  const [video, amd] = await Promise.all([
    run('wmic', WMIC_VIDEO_ARGS),
    run('wmic', WMIC_AMD_PNP_ARGS).catch(() => ''),
  ])
  return {
    gpu: classifyWindowsGpu(parseWmicCsv(video)),
    npu: classifyWindowsAmdNpu(parseWmicCsv(amd)),
    source: 'wmic',
  }
}

/**
 * GPU + AMD NPU on a Windows host. NEVER throws: a probe that cannot run is
 * `{ gpu: null, npu: null, source: 'none' }` and boot goes on — the node then
 * scores as a CPU node, which is correct for hardware we could not see.
 */
export async function probeWindowsHardware(
  run: WindowsProbeRunner,
  options: {
    readonly systemRoot?: string
    readonly onFallback?: (reason: string) => void
  } = {},
): Promise<WindowsHardware> {
  try {
    return await viaPowershell(run, options.systemRoot)
  } catch (powershellError) {
    options.onFallback?.(
      `PowerShell probe failed (${powershellError instanceof Error ? powershellError.message : String(powershellError)}); trying wmic`,
    )
  }
  try {
    return await viaWmic(run)
  } catch (wmicError) {
    options.onFallback?.(
      `wmic probe failed (${wmicError instanceof Error ? wmicError.message : String(wmicError)}); hardware unknown`,
    )
    return { gpu: null, npu: null, source: 'none' }
  }
}
