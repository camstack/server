/**
 * The accelerator part of the platform probe, re-run on its own (D919).
 *
 * The full probe runs once per process. A Coral is the one accelerator that is
 * plugged in, pulled out and moved between nodes while the process runs, so
 * its part (USB ids, PCIe apex units — reads of `/sys` and `/dev`, no model
 * load) is re-run periodically and on demand, and the node's inference device
 * list is rebuilt from the new answer. Pure: the scorer owns the cache.
 */
import { enumerateInferenceDevices, scoreRuntimes } from '@camstack/types'
import type { CoralInfo, InferenceDeviceDescriptor, PlatformCapabilities } from '@camstack/types'
import type { CoralDetection } from './coral-accelerators.js'

/** Device keys that appeared and disappeared between two probes, sorted. */
export interface InferenceDeviceSetChange {
  readonly appeared: readonly string[]
  readonly disappeared: readonly string[]
}

/** The result of one accelerator re-probe. */
export interface AcceleratorReprobe {
  readonly caps: PlatformCapabilities
  readonly change: InferenceDeviceSetChange
  readonly detection: CoralDetection
}

/** A stable signature of a Coral answer — what decides "did it change". */
export function coralSignature(coral: CoralInfo | null | undefined): string {
  if (coral == null) return 'none'
  const units = (coral.units ?? []).map((u) => `${u.bus}:${u.count}`).join(',')
  const unavailable = (coral.unavailable ?? [])
    .map((u) => `${u.bus}:${u.count}:${u.reason}`)
    .join(',')
  return `units=${units};unavailable=${unavailable}`
}

/** Which device keys a new probe added and removed. */
export function diffInferenceDevices(
  previous: readonly InferenceDeviceDescriptor[],
  next: readonly InferenceDeviceDescriptor[],
): InferenceDeviceSetChange {
  const before = new Set(previous.map((d) => d.key))
  const after = new Set(next.map((d) => d.key))
  return {
    appeared: [...after].filter((k) => !before.has(k)).toSorted(),
    disappeared: [...before].filter((k) => !after.has(k)).toSorted(),
  }
}

/**
 * The capabilities with a new Coral answer: hardware, scores and the device
 * enumeration are all derived again from it, so the edgetpu runtime and its
 * devices follow the hardware rather than the boot-time snapshot.
 */
export function withCoral(
  caps: PlatformCapabilities,
  coral: CoralInfo | null,
): PlatformCapabilities {
  const hardware = { ...caps.hardware, coral }
  const { scores, best } = scoreRuntimes(hardware)
  return {
    ...caps,
    hardware,
    scores: [...scores],
    bestScore: best,
    devices: enumerateInferenceDevices(hardware),
  }
}
