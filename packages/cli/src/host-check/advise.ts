/**
 * From a host inventory to what CamStack will use and what to pass. Every
 * entry is backed by the image and the server's probes:
 *  - Intel GPU: the `intel` image (iHD VAAPI/QSV decode, OpenVINO GPU), `/dev/dri`.
 *  - Intel NPU: OpenVINO NPU in the `intel` image, `/dev/accel`.
 *  - AMD GPU: the `amd` image (Mesa VAAPI + Vulkan for ONNX WebGPU), `/dev/dri`;
 *    the image carries no ROCm runtime, so `/dev/kfd` is never needed.
 *  - AMD XDNA NPU: detected by the server, no inference runtime yet.
 *  - Coral USB: the whole `/dev/bus/usb` plus `c 189:* rmw` (the stick
 *    re-enumerates); Coral PCIe/M.2: each `/dev/apex_N`.
 *  - Intel GPU older than Gen12 (Gen8-11): the `intel-legacy` image, `/dev/dri`, no NPU.
 *  - NVIDIA: the `nvidia` image (Turing+) or `nvidia-legacy` (Pascal/Maxwell), through
 *    `--gpus all` and the host's nvidia-container-toolkit, not a device line. Used only
 *    when no Intel/AMD GPU is: one image carries one vendor's runtime.
 *  - Hailo: not supported yet.
 * The variant table and the generation rules live in `../mcp/image-variants.ts`.
 * No `group_add` is needed: the image entrypoint hands every passed node to
 * the `camstack` user and drops supplementary groups.
 */
import {
  intelVariantForDeviceId,
  nvidiaVariantForName,
  variantTag,
  type ImageVariant,
} from '../mcp/image-variants.js'
import type { HostInventory, PciGpu } from './probe.js'

export type AcceleratorKind =
  | 'intel-gpu'
  | 'amd-gpu'
  | 'intel-npu'
  | 'amd-npu'
  | 'coral-usb'
  | 'coral-pcie'
  | 'nvidia'
  | 'hailo'

export type AcceleratorStatus = 'used' | 'detected-not-used' | 'unsupported'

export interface DetectedAccelerator {
  readonly kind: AcceleratorKind
  readonly label: string
  readonly status: AcceleratorStatus
  /** Host paths to pass into the container (empty unless `used`). */
  readonly hostPaths: readonly string[]
  /** Whether the device node is visible to THIS process (null = not applicable). */
  readonly visibleHere: boolean | null
  readonly note: string
  /** The image variant this accelerator needs (absent for Coral and unsupported kinds). */
  readonly variant?: ImageVariant
}

export interface UnraidAdvice {
  /** Values for the template's device fields: `<field name>: <value>`. */
  readonly deviceFields: readonly string[]
  /** The same devices as Extra Parameters, for a template without those fields. */
  readonly extraParameters: string
}

export interface Passthrough {
  readonly devices: readonly string[]
  readonly deviceCgroupRules: readonly string[]
  readonly dockerRunFlags: readonly string[]
  readonly compose: string
  readonly unraid: UnraidAdvice
  /** Lines for `/etc/pve/lxc/<id>.conf` on the Proxmox host. */
  readonly proxmoxLxc: readonly string[]
}

export const CORAL_USB_CGROUP_RULE = 'c 189:* rmw'
const DEFAULT_CT_RENDER_GID = 993
export const NVIDIA_RUN_FLAGS: readonly string[] = [
  '--gpus all',
  '-e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility',
]
const NVIDIA_COMPOSE = [
  '    environment:',
  '      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility',
  '    deploy:',
  '      resources:',
  '        reservations:',
  '          devices:',
  '            - driver: nvidia',
  '              count: all',
  '              capabilities: [gpu]',
]

const UNRAID_FIELD: Readonly<Record<string, string>> = {
  '/dev/dri': 'Intel/AMD iGPU',
  '/dev/accel': 'Intel NPU / AMD XDNA',
  '/dev/bus/usb': 'Coral USB (whole USB bus)',
  '/dev/apex_0': 'Coral PCIe/M.2 unit 1',
  '/dev/apex_1': 'Coral PCIe/M.2 unit 2',
}

function nvidiaName(inv: HostInventory): string | null {
  return /^GPU \d+:\s*(.+?)\s*(\(UUID|$)/m.exec(inv.nvidiaSmi ?? '')?.[1] ?? null
}

function nvidiaEntry(name: string, where: string, inv: HostInventory): DetectedAccelerator {
  const variant = nvidiaVariantForName(name)
  return {
    kind: 'nvidia',
    label: `${name}${where}`,
    status: 'used',
    hostPaths: [],
    // nvidia-smi answering on the host is the proof the driver is there.
    visibleHere: inv.nvidiaSmi !== null ? true : null,
    variant,
    note: `CUDA inference through the ${variantTag(variant)} image: needs --gpus all and nvidia-container-toolkit on the host.`,
  }
}

function gpuEntry(gpu: PciGpu, inv: HostInventory): DetectedAccelerator | null {
  const where = `${gpu.vendorId}:${gpu.deviceId} at ${gpu.slot}`
  if (gpu.vendor === 'nvidia') {
    return nvidiaEntry(nvidiaName(inv) ?? 'NVIDIA GPU', ` (${where})`, inv)
  }
  if (gpu.vendor !== 'intel' && gpu.vendor !== 'amd') return null
  const kind = gpu.vendor === 'intel' ? 'intel-gpu' : 'amd-gpu'
  const label = `${gpu.vendor === 'intel' ? 'Intel' : 'AMD'} GPU (${where})`
  if (gpu.renderNode === null) {
    return {
      kind,
      label,
      status: 'detected-not-used',
      hostPaths: [],
      visibleHere: null,
      note: 'No render node: the host has not loaded a GPU driver for it (i915/xe or amdgpu).',
    }
  }
  return {
    kind,
    label: `${label}, ${gpu.renderNode}`,
    status: 'used',
    hostPaths: ['/dev/dri'],
    visibleHere: gpu.renderNodeVisible,
    variant: gpu.vendor === 'intel' ? (intelVariantForDeviceId(gpu.deviceId) ?? 'intel') : 'amd',
    note:
      gpu.vendor === 'intel'
        ? `Hardware video decode (VAAPI/QSV) and OpenVINO GPU inference${intelVariantForDeviceId(gpu.deviceId) === 'intel-legacy' ? '; a Gen8-Gen11 iGPU, so the intel-legacy image (no NPU driver)' : ''}.`
        : 'Hardware video decode (VAAPI) and ONNX WebGPU inference over Vulkan. No ROCm: /dev/kfd is not needed.',
  }
}

export function listAccelerators(inv: HostInventory): readonly DetectedAccelerator[] {
  const out: DetectedAccelerator[] = []
  for (const gpu of inv.gpus) {
    const entry = gpuEntry(gpu, inv)
    if (entry !== null) out.push(entry)
  }
  const nvidiaSeen = out.some((a) => a.kind === 'nvidia')
  if (!nvidiaSeen && (inv.nvidiaNodes.length > 0 || inv.nvidiaSmi !== null)) {
    out.push(nvidiaEntry(nvidiaName(inv) ?? 'NVIDIA GPU', '', inv))
  }
  // One image carries one vendor's runtime: next to a usable Intel/AMD GPU the
  // card is offered, not taken (the operator picks the nvidia tag to trade).
  const otherGpuUsed = out.some(
    (a) => (a.kind === 'intel-gpu' || a.kind === 'amd-gpu') && a.status === 'used',
  )
  if (otherGpuUsed) {
    for (const [i, a] of out.entries()) {
      if (a.kind !== 'nvidia' || a.variant === undefined) continue
      out[i] = {
        ...a,
        status: 'detected-not-used',
        note: `CUDA is available on this card with the ${variantTag(a.variant)} image, but that image carries no Intel/AMD runtime, so the iGPU above would stop being used. Pick it only if the card is the faster accelerator.`,
      }
    }
  }
  for (const accel of inv.accel) {
    if (accel.vendor === 'intel') {
      out.push({
        kind: 'intel-npu',
        label: `Intel NPU, ${accel.node}`,
        status: 'used',
        hostPaths: ['/dev/accel'],
        visibleHere: accel.visible,
        variant: 'intel',
        note: 'OpenVINO NPU inference (the intel image carries the NPU driver).',
      })
    } else if (accel.vendor === 'amd') {
      out.push({
        kind: 'amd-npu',
        label: `AMD XDNA NPU, ${accel.node}`,
        status: 'detected-not-used',
        hostPaths: [],
        visibleHere: accel.visible,
        note: 'Detected by CamStack, but it has no inference runtime yet.',
      })
    }
  }
  if (inv.coralUsb > 0) {
    out.push({
      kind: 'coral-usb',
      label: `Coral USB Edge TPU (${inv.coralUsb})`,
      status: 'used',
      hostPaths: ['/dev/bus/usb'],
      visibleHere: inv.usbBusVisible,
      note: `The whole USB bus plus the device-cgroup rule ${CORAL_USB_CGROUP_RULE}: the stick re-enumerates when its firmware loads.`,
    })
  }
  for (const apex of inv.coralPcieNodes) {
    out.push({
      kind: 'coral-pcie',
      label: `Coral PCIe/M.2 Edge TPU, ${apex.node}`,
      status: 'used',
      hostPaths: [apex.node],
      visibleHere: apex.visible,
      note: 'One device per unit (a dual card is two units).',
    })
  }
  if (inv.coralPcieUnbound > 0) {
    out.push({
      kind: 'coral-pcie',
      label: `Coral PCIe/M.2 Edge TPU without driver (${inv.coralPcieUnbound})`,
      status: 'detected-not-used',
      hostPaths: [],
      visibleHere: null,
      note: 'On the PCI bus, but no apex driver is bound, so there is no /dev/apex_N to pass.',
    })
  }
  for (const node of inv.hailoNodes) {
    out.push({
      kind: 'hailo',
      label: `Hailo, ${node}`,
      status: 'unsupported',
      hostPaths: [],
      visibleHere: true,
      note: 'Hailo: not supported by CamStack.',
    })
  }
  return out
}

export function pickImageTag(accelerators: readonly DetectedAccelerator[]): string {
  const used = accelerators.filter((a) => a.status === 'used')
  // An Intel NPU lives only in the intel image: it wins over a legacy-classified iGPU.
  if (used.some((a) => a.kind === 'intel-npu')) return variantTag('intel')
  const picked = used.find((a) => a.variant !== undefined)
  // No Coral- or CPU-specific image: those hosts take the intel image.
  return variantTag(picked?.variant ?? 'intel')
}

/** The nodes an LXC needs, one `devN:` per node, then the Coral USB bind. */
function proxmoxLines(
  accelerators: readonly DetectedAccelerator[],
  inv: HostInventory,
): readonly string[] {
  const gid = inv.renderGid ?? DEFAULT_CT_RENDER_GID
  const nodes: string[] = []
  for (const gpu of inv.gpus) {
    if (gpu.renderNode !== null && (gpu.vendor === 'intel' || gpu.vendor === 'amd')) {
      nodes.push(gpu.renderNode)
    }
  }
  for (const accel of inv.accel) if (accel.vendor === 'intel') nodes.push(accel.node)
  for (const apex of inv.coralPcieNodes) nodes.push(apex.node)
  const lines = nodes.map((node, i) => `dev${i}: ${node},gid=${gid},mode=0660`)
  if (accelerators.some((a) => a.kind === 'nvidia' && a.status === 'used')) {
    // The driver nodes the NVIDIA runtime inside the CT needs; nvidia-container-toolkit goes in the CT too.
    const driver = [...inv.nvidiaNodes, '/dev/nvidiactl', '/dev/nvidia-uvm']
    lines.push(...driver.map((node, i) => `dev${nodes.length + i}: ${node},mode=0666`))
  }
  if (accelerators.some((a) => a.kind === 'coral-usb')) {
    lines.push('lxc.cgroup2.devices.allow: c 189:* rwm')
    lines.push('lxc.mount.entry: /dev/bus/usb dev/bus/usb none bind,optional,create=dir')
  }
  return lines
}

function composeSnippet(
  devices: readonly string[],
  rules: readonly string[],
  nvidia: boolean,
): string {
  if (devices.length === 0 && !nvidia) return ''
  const lines =
    devices.length > 0 ? ['    devices:', ...devices.map((d) => `      - ${d}:${d}`)] : []
  if (nvidia) lines.push(...NVIDIA_COMPOSE)
  if (rules.length > 0) {
    lines.push('    device_cgroup_rules:', ...rules.map((r) => `      - '${r}'`))
  }
  return lines.join('\n')
}

export function buildPassthrough(
  accelerators: readonly DetectedAccelerator[],
  inv: HostInventory,
): Passthrough {
  const devices = [
    ...new Set(accelerators.filter((a) => a.status === 'used').flatMap((a) => a.hostPaths)),
  ]
  const rules = accelerators.some((a) => a.kind === 'coral-usb' && a.status === 'used')
    ? [CORAL_USB_CGROUP_RULE]
    : []
  const ruleFlags = rules.map((r) => `--device-cgroup-rule='${r}'`)
  const nvidia = accelerators.some((a) => a.kind === 'nvidia' && a.status === 'used')
  return {
    devices,
    deviceCgroupRules: rules,
    dockerRunFlags: [
      ...devices.map((d) => `--device ${d}`),
      ...ruleFlags,
      ...(nvidia ? NVIDIA_RUN_FLAGS : []),
    ],
    compose: composeSnippet(devices, rules, nvidia),
    unraid: {
      deviceFields: [
        ...devices.map((d) => `${UNRAID_FIELD[d] ?? 'Device'}: ${d}`),
        ...(nvidia
          ? [
              'Variable: NVIDIA_VISIBLE_DEVICES=all',
              'Variable: NVIDIA_DRIVER_CAPABILITIES=compute,video,utility',
            ]
          : []),
      ],
      extraParameters: [
        ...devices.map((d) => `--device=${d}`),
        ...ruleFlags,
        ...(nvidia ? ['--runtime=nvidia'] : []),
      ].join(' '),
    },
    proxmoxLxc: proxmoxLines(accelerators, inv),
  }
}
