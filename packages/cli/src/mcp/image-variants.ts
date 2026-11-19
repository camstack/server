/**
 * THE one table of image variants: which tag, for which hardware, and what the
 * host must provide. The install guide, `host-check`, the accelerator
 * diagnosis and the docs all read it; none keeps a second copy of the mapping.
 * The images themselves are the `Dockerfile` finals (#608).
 */

export const IMAGE_VARIANTS = ['intel', 'intel-legacy', 'amd', 'nvidia', 'nvidia-legacy'] as const
export type ImageVariant = (typeof IMAGE_VARIANTS)[number]

export interface ImageVariantInfo {
  readonly tag: string
  /** The hardware the variant serves, in the words an operator reads off the box. */
  readonly hardware: string
  /** When to pick it, and what it does NOT carry. */
  readonly when: string
  /** What the HOST must provide for the variant to reach the accelerator. */
  readonly hostNeeds: readonly string[]
  /** Set while the variant has not been run on the hardware it targets. */
  readonly caveat?: string
}

export const NVIDIA_CONTAINER_NEEDS: readonly string[] = [
  'The host NVIDIA driver and the NVIDIA Container Toolkit (nvidia-container-toolkit).',
  'Start the container with --gpus all (Compose: a gpus: all / deploy.resources.reservations.devices entry with driver nvidia).',
  'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility (the image sets it; keep it if you override the environment).',
]

export const IMAGE_VARIANT_TABLE: Readonly<Record<ImageVariant, ImageVariantInfo>> = {
  intel: {
    tag: 'intel-latest',
    hardware: 'Intel Gen12+ iGPU (Alder Lake, N100/N-series, Core Ultra), Intel Arc, Intel NPU',
    when: 'The default for any Intel host with a current iGPU or an Intel NPU: OpenVINO GPU/NPU inference and VAAPI/QSV decode. Also the tag for Coral-only and CPU-only hosts (there is no Coral- or CPU-specific image).',
    hostNeeds: ['/dev/dri for the iGPU; /dev/accel for the NPU (kernel 6.6+ and NPU firmware).'],
  },
  'intel-legacy': {
    tag: 'intel-legacy-latest',
    hardware:
      'Intel Gen8-Gen11 iGPU: Broadwell, Skylake, Kaby Lake, Coffee Lake, Comet Lake, Ice Lake, Jasper Lake, Elkhart Lake',
    when: 'Pick it when the iGPU predates Gen12: the current compute runtime dropped these. It carries the last runtime that supports them (24.35) and NO NPU driver; an Intel NPU needs the intel tag.',
    hostNeeds: ['/dev/dri.'],
  },
  amd: {
    tag: 'amd-latest',
    hardware: 'AMD iGPU / APU or Radeon GPU',
    when: 'AMD hosts: Mesa VAAPI decode and ONNX WebGPU (Vulkan) inference. No ROCm runtime, so /dev/kfd is never needed. It carries no OpenVINO GPU runtime: an Intel host must not use it.',
    hostNeeds: ['/dev/dri (renderD128), the amdgpu driver and Mesa RADV on the host.'],
  },
  nvidia: {
    tag: 'nvidia-latest',
    hardware: 'NVIDIA Turing or newer (RTX 20/30/40/50, GTX 16): compute capability 7.5 or higher',
    when: 'A host whose accelerator is an NVIDIA card: ONNX Runtime CUDA (onnxruntime-gpu on CUDA 12.8 + cuDNN 9). It carries no Intel or AMD runtime, so it does not use an iGPU next to the card.',
    hostNeeds: NVIDIA_CONTAINER_NEEDS,
  },
  'nvidia-legacy': {
    tag: 'nvidia-legacy-latest',
    hardware:
      'NVIDIA Pascal or Maxwell (GTX 10 / GTX 9, Quadro P/M, Titan X): compute capability 5.0 to 6.1',
    when: 'Use it only for a card the nvidia image cannot drive: CUDA 11.8 + cuDNN 8 with onnxruntime-gpu 1.18.1, the last build that supports these cards.',
    hostNeeds: NVIDIA_CONTAINER_NEEDS,
    caveat:
      'Not yet run on a Pascal or Maxwell card: expect to report back if CUDA does not come up.',
  },
}

/** The tag of a variant, e.g. `intel-legacy-latest`. */
export function variantTag(variant: ImageVariant): string {
  return IMAGE_VARIANT_TABLE[variant].tag
}

/** The table as plain lines, for a tool answer or a report. */
export function renderVariantTable(): readonly string[] {
  return IMAGE_VARIANTS.flatMap((v) => {
    const info = IMAGE_VARIANT_TABLE[v]
    return [
      `${info.tag}: ${info.hardware}.`,
      `  ${info.when}`,
      ...info.hostNeeds.map((n) => `  Host: ${n}`),
      ...(info.caveat === undefined ? [] : [`  Caveat: ${info.caveat}`]),
    ]
  })
}

/** Intel iGPU generation from the PCI device id (`0x3e92`); null when unknown. */
const INTEL_LEGACY_DEVICE_PREFIXES: ReadonlySet<string> = new Set([
  '16', // Broadwell, Gen8
  '19', // Skylake, Gen9
  '59', // Kaby Lake
  '3e', // Coffee Lake
  '9b', // Comet Lake
  '8a', // Ice Lake, Gen11
  '4e', // Jasper Lake
  '45', // Elkhart Lake
])
const INTEL_LEGACY_DEVICE_IDS: ReadonlySet<string> = new Set([
  '3184',
  '3185', // Gemini Lake
  '5a84',
  '5a85', // Apollo Lake
])
const INTEL_CURRENT_DEVICE_PREFIXES: ReadonlySet<string> = new Set([
  '9a', // Tiger Lake
  '46', // Alder Lake, N-series
  'a7', // Raptor Lake
  '4c', // Rocket Lake
  '49', // DG1
  '56', // Arc (DG2)
  '7d', // Meteor Lake
  '64', // Lunar Lake
])

export function intelVariantForDeviceId(deviceId: string): 'intel' | 'intel-legacy' | null {
  const id = deviceId.toLowerCase().replace(/^0x/, '')
  if (id.length !== 4) return null
  if (INTEL_LEGACY_DEVICE_IDS.has(id) || INTEL_LEGACY_DEVICE_PREFIXES.has(id.slice(0, 2))) {
    return 'intel-legacy'
  }
  return INTEL_CURRENT_DEVICE_PREFIXES.has(id.slice(0, 2)) ? 'intel' : null
}

/**
 * Intel iGPU generation from its marketing name (the platform probe reports a
 * name, not a device id). A bare "UHD Graphics" spans Gen11 and Gen12, so it
 * stays unknown.
 */
export function intelVariantForName(name: string): 'intel' | 'intel-legacy' | null {
  if (/\b(Arc|Xe|UHD Graphics\s*7\d\d|Iris Xe)\b/i.test(name)) return 'intel'
  if (
    /\b(HD Graphics\s*\d{3,4}|UHD Graphics\s*6\d\d|Iris(?: Plus)?(?: Graphics)?\s*(?:G\d|\d{3})|Iris Pro)\b/i.test(
      name,
    )
  ) {
    return 'intel-legacy'
  }
  return null
}

const NVIDIA_LEGACY_NAME =
  /\b(GTX\s*(?:9\d\d|10\d\d)|GT\s*10\d\d|TITAN\s*X|Titan\s*Xp|Quadro\s*[PM]\d+|Tesla\s*[PM]\d+|MX\s*[12]\d\d)\b/i

/**
 * Nvidia variant from the card name (`nvidia-smi -L`): Pascal and Maxwell are
 * the legacy image; every other name (GTX 16, RTX, A/L/H series) is Turing or
 * newer. Pre-Maxwell cards (Kepler) match neither image.
 */
export function nvidiaVariantForName(name: string): 'nvidia' | 'nvidia-legacy' {
  return NVIDIA_LEGACY_NAME.test(name) ? 'nvidia-legacy' : 'nvidia'
}
