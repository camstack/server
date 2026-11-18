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
 *  - NVIDIA and Hailo: not supported yet (no CUDA runtime in the image).
 * No `group_add` is needed: the image entrypoint hands every passed node to
 * the `camstack` user and drops supplementary groups.
 */
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
const NOT_SUPPORTED =
  'not supported yet: the CamStack image has no CUDA runtime. Do not pass it; it would stay idle.'

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

function gpuEntry(gpu: PciGpu, inv: HostInventory): DetectedAccelerator | null {
  const where = `${gpu.vendorId}:${gpu.deviceId} at ${gpu.slot}`
  if (gpu.vendor === 'nvidia') {
    const name = nvidiaName(inv) ?? 'NVIDIA GPU'
    return {
      kind: 'nvidia',
      label: `${name} (${where})`,
      status: 'unsupported',
      hostPaths: [],
      visibleHere: null,
      note: `NVIDIA: ${NOT_SUPPORTED}`,
    }
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
    note:
      gpu.vendor === 'intel'
        ? 'Hardware video decode (VAAPI/QSV) and OpenVINO GPU inference.'
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
    out.push({
      kind: 'nvidia',
      label: nvidiaName(inv) ?? 'NVIDIA GPU',
      status: 'unsupported',
      hostPaths: [],
      visibleHere: null,
      note: `NVIDIA: ${NOT_SUPPORTED}`,
    })
  }
  for (const accel of inv.accel) {
    if (accel.vendor === 'intel') {
      out.push({
        kind: 'intel-npu',
        label: `Intel NPU, ${accel.node}`,
        status: 'used',
        hostPaths: ['/dev/accel'],
        visibleHere: accel.visible,
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
  if (used.some((a) => a.kind === 'intel-gpu')) return 'intel-latest'
  if (used.some((a) => a.kind === 'amd-gpu')) return 'amd-latest'
  // No Coral- or CPU-specific image: those hosts take the intel image.
  return 'intel-latest'
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
  if (accelerators.some((a) => a.kind === 'coral-usb')) {
    lines.push('lxc.cgroup2.devices.allow: c 189:* rwm')
    lines.push('lxc.mount.entry: /dev/bus/usb dev/bus/usb none bind,optional,create=dir')
  }
  return lines
}

function composeSnippet(devices: readonly string[], rules: readonly string[]): string {
  if (devices.length === 0) return ''
  const lines = ['    devices:', ...devices.map((d) => `      - ${d}:${d}`)]
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
  return {
    devices,
    deviceCgroupRules: rules,
    dockerRunFlags: [...devices.map((d) => `--device ${d}`), ...ruleFlags],
    compose: composeSnippet(devices, rules),
    unraid: {
      deviceFields: devices.map((d) => `${UNRAID_FIELD[d] ?? 'Device'}: ${d}`),
      extraParameters: [...devices.map((d) => `--device=${d}`), ...ruleFlags].join(' '),
    },
    proxmoxLxc: proxmoxLines(accelerators, inv),
  }
}
