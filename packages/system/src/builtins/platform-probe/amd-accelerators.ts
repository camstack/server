import type { GpuInfo } from '@camstack/types'

/**
 * Filesystem seam for AMD iGPU detection — mirrors intel-accelerators.ts
 * so the classifier stays a pure, unit-testable function over injected reads.
 */
export interface AmdAcceleratorFs {
  listRenderNodes(): readonly string[]
  readVendor(renderNode: string): string
  /** PCI device id (0x15bf), empty when unreadable. */
  readDevice(renderNode: string): string
}

export interface AmdAccelerators {
  gpu: GpuInfo | null
}

const AMD_VENDOR = '0x1002'

/**
 * Known Radeon iGPU PCI device ids to a short gfx / marketing label for the
 * probe name. Unknown ids still report as AMD; the label is best-effort.
 */
const AMD_IGPU_BY_DEVICE: Readonly<Record<string, string>> = {
  '0x15bf': 'Radeon 760M (gfx1103)',
  '0x15c8': 'Radeon 780M (gfx1103)',
  '0x1900': 'Radeon 780M Hawk Point (gfx1103)',
  '0x150e': 'Radeon 890M Strix (gfx1150)',
}

function normalizePciId(raw: string): string {
  const t = raw.trim().toLowerCase()
  if (t.startsWith('0x')) return t
  // Hex digits without the 0x prefix (sysfs sometimes omits it).
  if (t.length > 0 && [...t].every((c) => '0123456789abcdef'.includes(c))) return '0x' + t
  return t
}

export function classifyAmdAccelerators(fsx: AmdAcceleratorFs): AmdAccelerators {
  let gpu: GpuInfo | null = null
  for (const node of fsx.listRenderNodes()) {
    if (normalizePciId(fsx.readVendor(node)) !== AMD_VENDOR) continue
    const deviceId = normalizePciId(fsx.readDevice(node))
    const leaf = node.split('/').pop() ?? node
    const label = AMD_IGPU_BY_DEVICE[deviceId] ?? 'AMD iGPU (' + leaf + ')'
    gpu = {
      type: 'amd',
      name: label.startsWith('Radeon') ? 'AMD ' + label : label,
    }
    break
  }
  return { gpu }
}
