/**
 * Modal's offer, as this provider shows it. Prices are Modal's published
 * per-second list prices as USD per hour (modal.com/pricing, read 2026-10-08);
 * they are an ESTIMATE source only — every cost the hub shows says so. The
 * region multipliers are Modal's documented surcharge for pinning a region;
 * whether the Starter plan may pin one at all is unverified (spike A0).
 */
import type { TrainingGpuOption, TrainingRegionOption } from '@camstack/types'

export const MODAL_GPUS: readonly TrainingGpuOption[] = [
  { id: 'T4', label: 'NVIDIA T4 (16 GB)', usdPerHour: 0.59, vramGb: 16 },
  { id: 'L4', label: 'NVIDIA L4 (24 GB)', usdPerHour: 0.8, vramGb: 24 },
  { id: 'A10G', label: 'NVIDIA A10G (24 GB)', usdPerHour: 1.1, vramGb: 24 },
  { id: 'L40S', label: 'NVIDIA L40S (48 GB)', usdPerHour: 1.95, vramGb: 48 },
  { id: 'A100-40GB', label: 'NVIDIA A100 (40 GB)', usdPerHour: 2.1, vramGb: 40 },
  { id: 'A100-80GB', label: 'NVIDIA A100 (80 GB)', usdPerHour: 2.5, vramGb: 80 },
  { id: 'H100', label: 'NVIDIA H100 (80 GB)', usdPerHour: 3.95, vramGb: 80 },
]

export const MODAL_REGIONS: readonly TrainingRegionOption[] = [
  { id: '', label: 'Any region (cheapest)', priceMultiplier: 1 },
  { id: 'us', label: 'United States', priceMultiplier: 1.15 },
  { id: 'eu', label: 'Europe', priceMultiplier: 1.15 },
  { id: 'ap', label: 'Asia-Pacific', priceMultiplier: 1.15 },
]

export const MODAL_DEFAULT_GPU = 'L4'
/** A dataset upload is streamed into a Volume; Modal's own ceiling is far above this. */
export const MODAL_MAX_DATASET_BYTES = 20 * 1024 ** 3
/** Modal's Sandbox lifetime ceiling (24 h). */
export const MODAL_MAX_RUNTIME_SEC = 24 * 3600

export function modalPricePerSecond(gpuType: string, region: string): number {
  const gpu = MODAL_GPUS.find((g) => g.id === gpuType)
  const multiplier = MODAL_REGIONS.find((r) => r.id === region)?.priceMultiplier ?? 1
  return gpu === undefined ? 0 : (gpu.usdPerHour * multiplier) / 3600
}
