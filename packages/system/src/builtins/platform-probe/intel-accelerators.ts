import type { GpuInfo } from '@camstack/types'

/**
 * Filesystem seam for Intel iGPU detection — the classifier stays a pure,
 * unit-testable function over injected reads. The Intel NPU ("AI Boost") is a
 * separate DRM accel device with its own classifier — see `intel-npu.ts`.
 */
export interface AcceleratorFs {
  listRenderNodes(): readonly string[]
  readVendor(renderNode: string): string
}

export interface IntelAccelerators {
  gpu: GpuInfo | null
}

const INTEL_VENDOR = '0x8086'

export function classifyIntelAccelerators(fsx: AcceleratorFs): IntelAccelerators {
  let gpu: GpuInfo | null = null
  for (const node of fsx.listRenderNodes()) {
    if (fsx.readVendor(node).trim() === INTEL_VENDOR) {
      gpu = { type: 'intel', name: `Intel iGPU (${node.split('/').pop()})` }
      break
    }
  }
  return { gpu }
}
