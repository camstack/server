import fs from 'node:fs'
import type { CoralBusUnits, CoralInfo, CoralUnavailableUnits } from '@camstack/types'
import {
  chooseEdgetpuDelegate,
  EDGETPU_LIB_ENV,
  nodeDataRootFromEnv,
  type EdgetpuDelegateLookup,
} from '@camstack/types/node'

/**
 * Filesystem seam for Coral Edge TPU detection (USB and PCIe/M.2) — mirrors
 * the `AcceleratorFs` pattern in `intel-accelerators.ts` so the classifier
 * stays a pure, unit-testable function over injected reads.
 */
export interface CoralFs {
  /**
   * USB device directory names under `/sys/bus/usb/devices` (e.g. `2-4`), or
   * `null` when the bus cannot be read at all (no `/sys`, a restricted view).
   * `null` and an empty listing both mean "the bus is not observable".
   */
  listUsbDevices(): readonly string[] | null
  /** Read a `<sysfsNode>/<attr>` value (idVendor / idProduct / busnum / devnum), trimmed. */
  readUsbAttr(device: string, attr: string): string
  /** PCI function names under `/sys/bus/pci/devices` (e.g. `0000:03:00.0`). */
  listPciDevices(): readonly string[]
  /** Read a PCI function's `vendor` / `device` attribute (e.g. `0x1ac1`), trimmed. */
  readPciAttr(device: string, attr: string): string
  /** Entry names under `/sys/class/apex` (the gasket/apex driver: `apex_0`, …). */
  listApexClass(): readonly string[]
  /** Whether this process can open a device node (`/dev/apex_N`, `/dev/bus/usb/…`) for read AND write. */
  canOpen(path: string): boolean
  /** Whether a filesystem path exists (the libedgetpu delegate, `/dev/apex_N`). */
  exists(path: string): boolean
}

/**
 * Coral USB Edge TPU USB identifiers.
 *
 * The device enumerates as `1a6e:089a` (Global Unichip) BEFORE the libedgetpu
 * firmware loads, then re-enumerates as `18d1:9302` (Google) AFTER. Either id
 * means a Coral is physically attached, so both count as a positive signal.
 */
const CORAL_USB_IDS: readonly { vendor: string; product: string }[] = [
  { vendor: '1a6e', product: '089a' },
  { vendor: '18d1', product: '9302' },
]

/** The PCIe / M.2 Coral's PCI function id (Global Unichip "Apex"). */
const CORAL_PCI_VENDOR = '0x1ac1'
const CORAL_PCI_DEVICE = '0x089a'

/** A unit the apex driver bound: `/sys/class/apex/apex_<N>` ↔ `/dev/apex_<N>`. */
const APEX_ENTRY = /^apex_(\d+)$/

/**
 * Where this node would find the libedgetpu delegate — the same lookup the
 * Python pool runs (`edgetpu_device.edgetpu_library_path`): the
 * `CAMSTACK_EDGETPU_LIB` override, the copy the deps downloader staged under
 * `<CAMSTACK_DATA>/deps/edgetpu/lib/`, the hub's historical
 * `/data/deps/edgetpu/lib/libedgetpu.so.1`.
 */
export type EdgetpuDelegateHost = Omit<EdgetpuDelegateLookup, 'exists'>

function currentDelegateHost(): EdgetpuDelegateHost {
  return {
    platform: process.platform,
    dataDir: nodeDataRootFromEnv(process.env),
    override: process.env[EDGETPU_LIB_ENV],
  }
}

/** Whether this process could see the USB bus at all. */
export type CoralUsbBusView = 'observed' | 'unobservable'

/**
 * Which evidence decided the Coral answer — logged by the probe so a node
 * that reports (or stops reporting) a Coral says WHY:
 *  - `usb-ids` — a Coral USB id is on the bus (usable or not: its device node
 *    decides, see {@link CoralDetection.inaccessibleUsbNodes});
 *  - `pci` — a PCIe/M.2 Coral (usable or not) is on the PCI bus;
 *  - `delegate-fallback` — the USB bus is not observable and the libedgetpu
 *    delegate is installed, so one USB unit is ASSUMED;
 *  - `none` — no Coral.
 */
export type CoralDecision = 'usb-ids' | 'pci' | 'delegate-fallback' | 'none'

export interface CoralDetection {
  readonly info: CoralInfo | null
  readonly usbBus: CoralUsbBusView
  readonly decidedBy: CoralDecision
  /**
   * The device node of every USB Coral sysfs lists but this process cannot
   * open read/write (`/dev/bus/usb/<BBB>/<DDD>`, or `<sysfs entry>` when
   * sysfs gave no bus/device number) — the evidence behind a USB
   * `device-not-accessible`. Empty when every listed stick is usable.
   */
  readonly inaccessibleUsbNodes: readonly string[]
}

interface UsbCoralView {
  readonly usable: number
  readonly inaccessibleNodes: readonly string[]
}

/** usbfs names a device `/dev/bus/usb/<busnum>/<devnum>`, each zero-padded to three digits. */
function usbDeviceNode(device: string, fsx: CoralFs): string | null {
  const bus = Number.parseInt(fsx.readUsbAttr(device, 'busnum'), 10)
  const dev = Number.parseInt(fsx.readUsbAttr(device, 'devnum'), 10)
  if (!Number.isInteger(bus) || !Number.isInteger(dev) || bus <= 0 || dev <= 0) return null
  return `/dev/bus/usb/${String(bus).padStart(3, '0')}/${String(dev).padStart(3, '0')}`
}

/**
 * USB units: sysfs is the HOST's view — a container whose `/dev/bus/usb`
 * mapping was removed still lists the stick under `/sys/bus/usb/devices`. A
 * listed Coral is usable only when its usbfs device node is in this process's
 * view AND opens read/write; otherwise it is present but not accessible.
 */
function classifyUsb(devices: readonly string[], fsx: CoralFs): UsbCoralView {
  let usable = 0
  const inaccessibleNodes: string[] = []
  for (const device of devices) {
    const vendor = fsx.readUsbAttr(device, 'idVendor').toLowerCase()
    const product = fsx.readUsbAttr(device, 'idProduct').toLowerCase()
    if (!CORAL_USB_IDS.some((id) => id.vendor === vendor && id.product === product)) continue
    const node = usbDeviceNode(device, fsx)
    if (node !== null && fsx.exists(node) && fsx.canOpen(node)) usable++
    else inaccessibleNodes.push(node ?? `/sys/bus/usb/devices/${device}`)
  }
  return { usable, inaccessibleNodes }
}

function countPciCorals(fsx: CoralFs): number {
  let count = 0
  for (const device of fsx.listPciDevices()) {
    const vendor = fsx.readPciAttr(device, 'vendor').toLowerCase()
    const product = fsx.readPciAttr(device, 'device').toLowerCase()
    if (vendor === CORAL_PCI_VENDOR && product === CORAL_PCI_DEVICE) count++
  }
  return count
}

interface PciCoralView {
  readonly usable: number
  readonly notAccessible: number
  readonly driverMissing: number
}

/**
 * PCIe units: each `/sys/class/apex/apex_N` is a unit the driver bound; it is
 * usable only when `/dev/apex_N` is in this process's view AND opens read/write.
 * PCI functions with the Coral id beyond the bound units have no driver.
 */
function classifyPci(fsx: CoralFs): PciCoralView {
  let usable = 0
  let notAccessible = 0
  for (const entry of fsx.listApexClass()) {
    const match = APEX_ENTRY.exec(entry)
    if (match === null) continue
    const node = `/dev/apex_${match[1]}`
    if (fsx.exists(node) && fsx.canOpen(node)) usable++
    else notAccessible++
  }
  const driverMissing = Math.max(0, countPciCorals(fsx) - usable - notAccessible)
  return { usable, notAccessible, driverMissing }
}

/**
 * Detect Coral Edge TPUs on USB and PCIe/M.2 — the answer only. See
 * {@link detectCoralAccelerator} for the evidence that decided it.
 */
export function classifyCoralAccelerator(
  fsx: CoralFs,
  delegateHost: EdgetpuDelegateHost = currentDelegateHost(),
): CoralInfo | null {
  return detectCoralAccelerator(fsx, delegateHost).info
}

/**
 * Detect Coral Edge TPUs on USB and PCIe/M.2, with the evidence that decided.
 *
 * - USB: every matching USB device counts (multiple Corals run concurrently),
 *   usable only if its `/dev/bus/usb/<BBB>/<DDD>` node opens read/write — a
 *   listed stick whose node is missing or refused is `device-not-accessible`.
 * - PCIe: the apex driver's units, each usable only if its device node opens;
 *   a Coral PCI function the driver did not bind is `driver-missing`.
 * - Fallback: when the USB bus is NOT OBSERVABLE (`/sys/bus/usb/devices`
 *   missing, unreadable or empty — a macOS desktop, a restricted container)
 *   and no PCI Coral was seen, an installed libedgetpu delegate means one USB
 *   Coral is assumed. A bus that IS readable and lists no Coral id is the
 *   answer: no USB Coral. The delegate stays installed after a stick is
 *   unplugged or moved to another node, so it is evidence only where nothing
 *   better exists (D919).
 *
 * Returns `null` only when no Coral was found at all; a present-but-unusable
 * Coral is reported with its typed reason, never as absent (D393/D315).
 */
export function detectCoralAccelerator(
  fsx: CoralFs,
  delegateHost: EdgetpuDelegateHost = currentDelegateHost(),
): CoralDetection {
  const usbDevices = fsx.listUsbDevices()
  const usbBus: CoralUsbBusView =
    usbDevices !== null && usbDevices.length > 0 ? 'observed' : 'unobservable'
  const usb: UsbCoralView =
    usbDevices === null ? { usable: 0, inaccessibleNodes: [] } : classifyUsb(usbDevices, fsx)
  const usbSeen = usb.usable + usb.inaccessibleNodes.length
  const inaccessibleUsbNodes = usb.inaccessibleNodes
  const pci = classifyPci(fsx)

  const units: CoralBusUnits[] = []
  if (usb.usable > 0) units.push({ bus: 'usb', count: usb.usable })
  if (pci.usable > 0) units.push({ bus: 'pci', count: pci.usable })

  const unavailable: CoralUnavailableUnits[] = []
  if (usb.inaccessibleNodes.length > 0)
    unavailable.push({
      bus: 'usb',
      count: usb.inaccessibleNodes.length,
      reason: 'device-not-accessible',
    })
  if (pci.driverMissing > 0)
    unavailable.push({
      bus: 'pci',
      count: pci.driverMissing,
      reason: 'driver-missing',
    })
  if (pci.notAccessible > 0)
    unavailable.push({
      bus: 'pci',
      count: pci.notAccessible,
      reason: 'device-not-accessible',
    })

  if (units.length > 0 || unavailable.length > 0) {
    const info: CoralInfo =
      unavailable.length > 0
        ? { type: 'coral-edgetpu', units, unavailable }
        : { type: 'coral-edgetpu', units }
    return {
      info,
      usbBus,
      decidedBy: usbSeen > 0 ? 'usb-ids' : 'pci',
      inaccessibleUsbNodes,
    }
  }
  if (
    usbBus === 'unobservable' &&
    chooseEdgetpuDelegate({ ...delegateHost, exists: (p) => fsx.exists(p) }) !== null
  ) {
    return {
      info: { type: 'coral-edgetpu', units: [{ bus: 'usb', count: 1 }] },
      usbBus,
      decidedBy: 'delegate-fallback',
      inaccessibleUsbNodes,
    }
  }
  return { info: null, usbBus, decidedBy: 'none', inaccessibleUsbNodes }
}

function safeListOrNull(dir: string): readonly string[] | null {
  try {
    return fs.readdirSync(dir)
  } catch {
    return null
  }
}

function safeList(dir: string): readonly string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function safeRead(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/** The real filesystem view: `/sys` for enumeration, `/dev` for access. */
export const nodeCoralFs: CoralFs = {
  listUsbDevices: () => safeListOrNull('/sys/bus/usb/devices'),
  readUsbAttr: (device, attr) => safeRead(`/sys/bus/usb/devices/${device}/${attr}`),
  listPciDevices: () => safeList('/sys/bus/pci/devices'),
  readPciAttr: (device, attr) => safeRead(`/sys/bus/pci/devices/${device}/${attr}`),
  listApexClass: () => safeList('/sys/class/apex'),
  canOpen: (path) => {
    try {
      fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  exists: (path) => {
    try {
      return fs.existsSync(path)
    } catch {
      return false
    }
  },
}
