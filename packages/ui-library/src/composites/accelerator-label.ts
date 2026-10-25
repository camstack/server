/**
 * The ONE name of an inference accelerator, everywhere it is shown: the step
 * matrix's column headers, the load-balancing rows, the camera assignments
 * table, Model Studio's device chips. Four pages had drifted into four
 * spellings of the same device — the Mac mini's Neural Engine read "Coreml All"
 * in the step matrix and "Apple ANE" on Load balancing.
 */

/** What naming needs from a device row (`NodeInferenceDevice` satisfies it). */
export interface AcceleratorIdentity {
  readonly key: string
  readonly backend: string
  readonly device: string
}

interface Names {
  readonly label: string
  readonly short: string
}

const CORAL_UNIT = /^(usb|pci)(?::(\d+))?$/

/**
 * One Coral per node keeps the plain name; a second unit, or one on PCIe, says
 * which: `edgetpu:usb` "Coral Edge TPU", `edgetpu:usb:1` "Coral Edge TPU (USB 2)",
 * `edgetpu:pci` "Coral Edge TPU (PCIe)", `edgetpu:pci:1` "Coral Edge TPU (PCIe 2)".
 */
function coralNames(dev: string): Names {
  // i18n-ignore-start: hardware product names
  const match = CORAL_UNIT.exec(dev)
  if (match === null || (match[1] === 'usb' && match[2] === undefined))
    return { label: 'Coral Edge TPU', short: 'Coral' }
  const bus = match[1] === 'pci' ? 'PCIe' : 'USB'
  const unit = match[2] === undefined ? bus : `${bus} ${Number(match[2]) + 1}`
  return { label: `Coral Edge TPU (${unit})`, short: `Coral ${unit}` }
  // i18n-ignore-end
}

function names(device: AcceleratorIdentity): Names {
  const backend = device.backend.toLowerCase()
  const dev = device.device.toLowerCase()
  if (device.key === 'cpu' || dev === 'cpu' || backend === 'cpu')
    return { label: 'CPU', short: 'CPU' }
  // i18n-ignore-start: hardware product names
  if (dev === 'npu') return { label: 'Intel NPU', short: 'NPU' }
  if (dev === 'gpu' || dev === 'igpu') return { label: 'Intel iGPU', short: 'iGPU' }
  if (backend === 'edgetpu') return coralNames(dev)
  if (backend === 'coreml') return { label: 'Apple Neural Engine', short: 'ANE' }
  // i18n-ignore-end
  const pretty = `${device.backend} ${device.device}`
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
  return { label: pretty.length > 0 ? pretty : device.key, short: device.backend || device.key }
}

/** "Intel NPU", "Apple Neural Engine", "Coral Edge TPU", "CPU" — Auto tune's names too. */
export function acceleratorLabel(device: AcceleratorIdentity): string {
  return names(device).label
}

/** "NPU", "ANE", "Coral", "CPU" — chips and tabs. */
export function acceleratorShortLabel(device: AcceleratorIdentity): string {
  return names(device).short
}
