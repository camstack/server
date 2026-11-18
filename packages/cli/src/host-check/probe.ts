/**
 * Read-only inventory of the accelerators a Linux host has, for `camstack
 * host-check`. Everything comes through the `HostFs` seam so the specs run
 * over a fake /sys + /dev tree; no root, nothing written, nothing sent.
 *
 * The PCI scan is the GPU inventory (sysfs is the host's view even inside a
 * container), the DRM render nodes say which ones this process could open.
 * The ids match the server's own probes (`packages/system/src/builtins/
 * platform-probe`): Coral USB `1a6e:089a` / `18d1:9302`, Coral PCIe `1ac1:089a`.
 */

export interface HostFs {
  /** Child names of a directory; empty when it is missing or unreadable. */
  listDir(path: string): readonly string[]
  /** A small text file, or null when it is missing or unreadable. */
  readText(path: string): string | null
  exists(path: string): boolean
}

export type GpuVendor = 'intel' | 'amd' | 'nvidia' | 'other'

export interface PciGpu {
  readonly slot: string
  readonly vendor: GpuVendor
  readonly vendorId: string
  readonly deviceId: string
  /** `/dev/dri/renderDNNN` that belongs to this GPU, or null (no DRM driver). */
  readonly renderNode: string | null
  /** Whether the render node exists in THIS process's /dev (passed in). */
  readonly renderNodeVisible: boolean
}

export interface AccelNode {
  readonly node: string
  readonly vendor: 'intel' | 'amd' | 'other'
  readonly visible: boolean
}

export type ContainerKind = 'docker' | 'podman' | 'lxc' | 'other'

export interface ApexNode {
  readonly node: string
  readonly visible: boolean
}

export interface CpuInfo {
  readonly vendor: string | null
  readonly model: string | null
}

export interface HostInventory {
  readonly gpus: readonly PciGpu[]
  readonly accel: readonly AccelNode[]
  readonly coralUsb: number
  /** Whether /dev/bus/usb exists in this process's view. */
  readonly usbBusVisible: boolean
  /** `/dev/apex_N` nodes the apex driver bound. */
  readonly coralPcieNodes: readonly ApexNode[]
  /** PCIe Corals on the bus with no apex driver bound. */
  readonly coralPcieUnbound: number
  readonly nvidiaNodes: readonly string[]
  readonly nvidiaSmi: string | null
  readonly hailoNodes: readonly string[]
  readonly cpu: CpuInfo
  readonly renderGid: number | null
  readonly container: ContainerKind | null
  readonly proxmoxHost: boolean
  readonly unraidHost: boolean
}

const PCI_DEVICES = '/sys/bus/pci/devices'
const DRM_CLASS = '/sys/class/drm'
const ACCEL_CLASS = '/sys/class/accel'
const APEX_CLASS = '/sys/class/apex'
const USB_DEVICES = '/sys/bus/usb/devices'

const VENDOR_BY_PCI_ID: Readonly<Record<string, GpuVendor>> = {
  '0x8086': 'intel',
  '0x1002': 'amd',
  '0x10de': 'nvidia',
}
const CORAL_USB_IDS: readonly string[] = ['1a6e:089a', '18d1:9302']
const CORAL_PCI_ID = '0x1ac1:0x089a'

function attr(fs: HostFs, path: string): string {
  return (fs.readText(path) ?? '').trim().toLowerCase()
}

/** PCI slot → render node, from each render node's `device/uevent`. */
function renderNodesBySlot(fs: HostFs): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const name of fs.listDir(DRM_CLASS)) {
    if (!/^renderD\d+$/.test(name)) continue
    const uevent = fs.readText(`${DRM_CLASS}/${name}/device/uevent`) ?? ''
    const slot = /^PCI_SLOT_NAME=(.+)$/m.exec(uevent)?.[1]?.trim()
    if (slot !== undefined) out.set(slot.toLowerCase(), `/dev/dri/${name}`)
  }
  return out
}

function probeGpus(fs: HostFs): readonly PciGpu[] {
  const render = renderNodesBySlot(fs)
  const out: PciGpu[] = []
  for (const slot of fs.listDir(PCI_DEVICES)) {
    const base = `${PCI_DEVICES}/${slot}`
    // PCI class 0x03xxxx = display controller.
    if (!attr(fs, `${base}/class`).startsWith('0x03')) continue
    const vendorId = attr(fs, `${base}/vendor`)
    const node = render.get(slot.toLowerCase()) ?? null
    out.push({
      slot,
      vendor: VENDOR_BY_PCI_ID[vendorId] ?? 'other',
      vendorId,
      deviceId: attr(fs, `${base}/device`),
      renderNode: node,
      renderNodeVisible: node !== null && fs.exists(node),
    })
  }
  return out
}

function probeAccel(fs: HostFs): readonly AccelNode[] {
  return fs
    .listDir(ACCEL_CLASS)
    .filter((n) => /^accel\d+$/.test(n))
    .map((name) => {
      const vendorId = attr(fs, `${ACCEL_CLASS}/${name}/device/vendor`)
      const vendor = vendorId === '0x8086' ? 'intel' : vendorId === '0x1022' ? 'amd' : 'other'
      const node = `/dev/accel/${name}`
      return { node, vendor, visible: fs.exists(node) }
    })
}

function probeCoralUsb(fs: HostFs): number {
  let count = 0
  for (const dev of fs.listDir(USB_DEVICES)) {
    const id = `${attr(fs, `${USB_DEVICES}/${dev}/idVendor`)}:${attr(fs, `${USB_DEVICES}/${dev}/idProduct`)}`
    if (CORAL_USB_IDS.includes(id)) count++
  }
  return count
}

function countUnboundCoralPcie(fs: HostFs, bound: number): number {
  let onBus = 0
  for (const slot of fs.listDir(PCI_DEVICES)) {
    const base = `${PCI_DEVICES}/${slot}`
    if (`${attr(fs, `${base}/vendor`)}:${attr(fs, `${base}/device`)}` === CORAL_PCI_ID) onBus++
  }
  return Math.max(0, onBus - bound)
}

function devNodes(fs: HostFs, pattern: RegExp): readonly string[] {
  return fs
    .listDir('/dev')
    .filter((n) => pattern.test(n))
    .map((n) => `/dev/${n}`)
}

function probeCpu(fs: HostFs): CpuInfo {
  const info = fs.readText('/proc/cpuinfo') ?? ''
  return {
    vendor: /^vendor_id\s*:\s*(.+)$/m.exec(info)?.[1]?.trim() ?? null,
    model: /^model name\s*:\s*(.+)$/m.exec(info)?.[1]?.trim() ?? null,
  }
}

function probeRenderGid(fs: HostFs): number | null {
  const line = /^render:[^:]*:(\d+):/m.exec(fs.readText('/etc/group') ?? '')
  return line ? Number(line[1]) : null
}

function probeContainer(fs: HostFs): ContainerKind | null {
  if (fs.exists('/.dockerenv')) return 'docker'
  if (fs.exists('/run/.containerenv')) return 'podman'
  const systemd = (fs.readText('/run/systemd/container') ?? '').trim()
  if (systemd === 'lxc') return 'lxc'
  if (systemd === 'docker') return 'docker'
  if (systemd === 'podman') return 'podman'
  if (systemd.length > 0) return 'other'
  return null
}

export function probeHost(fs: HostFs, nvidiaSmi: string | null): HostInventory {
  const apex: readonly ApexNode[] = fs
    .listDir(APEX_CLASS)
    .filter((n) => /^apex_\d+$/.test(n))
    .map((n) => ({ node: `/dev/${n}`, visible: fs.exists(`/dev/${n}`) }))
  return {
    gpus: probeGpus(fs),
    accel: probeAccel(fs),
    coralUsb: probeCoralUsb(fs),
    usbBusVisible: fs.exists('/dev/bus/usb'),
    coralPcieNodes: apex,
    coralPcieUnbound: countUnboundCoralPcie(fs, apex.length),
    nvidiaNodes: devNodes(fs, /^nvidia\d+$/),
    nvidiaSmi: nvidiaSmi !== null && nvidiaSmi.trim().length > 0 ? nvidiaSmi.trim() : null,
    hailoNodes: devNodes(fs, /^hailo\d+$/),
    cpu: probeCpu(fs),
    renderGid: probeRenderGid(fs),
    container: probeContainer(fs),
    proxmoxHost: fs.exists('/etc/pve'),
    unraidHost: fs.exists('/etc/unraid-version'),
  }
}
