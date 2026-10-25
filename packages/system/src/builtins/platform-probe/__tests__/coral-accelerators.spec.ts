import { describe, expect, it } from 'vitest'
import {
  classifyCoralAccelerator,
  detectCoralAccelerator,
  type CoralFs,
} from '../coral-accelerators.js'

/**
 * Pure-function tests for Coral USB Edge TPU detection. Both the pre-init
 * (`1a6e:089a`) and post-init (`18d1:9302`) USB ids count as a positive
 * signal; the installed libedgetpu delegate is an independent fallback signal.
 */
function makeFs(over: Partial<CoralFs> = {}): CoralFs {
  return {
    listUsbDevices: () => [],
    readUsbAttr: () => '',
    listPciDevices: () => [],
    readPciAttr: () => '',
    listApexClass: () => [],
    canOpen: () => false,
    exists: () => false,
    ...over,
  }
}

/** The `/dev/bus/usb/<BBB>/<DDD>` node of a stick read through {@link usbIds}. */
const USB_BUSNUM = '2'
const USB_DEVNUM = '4'
const USB_NODE = '/dev/bus/usb/002/004'

/**
 * A USB attribute reader: `idVendor` / `idProduct`, plus the `busnum` /
 * `devnum` every sysfs USB device carries.
 */
function usbIds(vendor: string, product: string): (device: string, attr: string) => string {
  return (_d, attr) => {
    if (attr === 'idVendor') return vendor
    if (attr === 'idProduct') return product
    if (attr === 'busnum') return USB_BUSNUM
    if (attr === 'devnum') return USB_DEVNUM
    return ''
  }
}

/** The device node of every listed USB Coral is in this view and opens read/write. */
const usbNodeAccessible: Pick<CoralFs, 'exists' | 'canOpen'> = {
  exists: (p) => p.startsWith('/dev/bus/usb/'),
  canOpen: (p) => p.startsWith('/dev/bus/usb/'),
}

describe('classifyCoralAccelerator', () => {
  it('detects the pre-init Coral USB id (1a6e:089a) and counts it', () => {
    const fs = makeFs({
      listUsbDevices: () => ['2-4'],
      readUsbAttr: usbIds('1a6e', '089a'),
      ...usbNodeAccessible,
    })
    expect(classifyCoralAccelerator(fs)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 1 }],
    })
  })

  it('detects the post-init Coral USB id (18d1:9302), case-insensitively', () => {
    const fs = makeFs({
      listUsbDevices: () => ['2-4'],
      readUsbAttr: usbIds('18D1', '9302'),
      ...usbNodeAccessible,
    })
    expect(classifyCoralAccelerator(fs)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 1 }],
    })
  })

  it('counts every attached Coral (multi-TPU concurrency)', () => {
    const attrs: Record<string, [string, string]> = {
      '2-1': ['18d1', '9302'],
      '2-2': ['1a6e', '089a'],
      '3-1': ['8086', '1234'], // non-Coral, ignored
      '3-2': ['18d1', '9302'],
    }
    const fs = makeFs({
      listUsbDevices: () => ['2-1', '2-2', '3-1', '3-2'],
      readUsbAttr: (d, attr) => usbIds(attrs[d]![0], attrs[d]![1])(d, attr),
      ...usbNodeAccessible,
    })
    expect(classifyCoralAccelerator(fs)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 3 }],
    })
  })

  it('falls back to the installed libedgetpu delegate (count unknown) when no USB device matches', () => {
    const fs = makeFs({ exists: (p) => p.endsWith('libedgetpu.so.1') })
    expect(classifyCoralAccelerator(fs)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 1 }],
    })
  })

  it('falls back to a delegate the deps downloader STAGED under the node data root (desktop)', () => {
    // A macOS desktop has no /sys: the staged dylib is its only Coral signal,
    // and it lives under the app's data directory, never under /data.
    const staged = '/Users/me/CamStack/data/deps/edgetpu/lib/libedgetpu.1.dylib'
    const fs = makeFs({ exists: (p) => p === staged })
    const host = {
      platform: 'darwin' as const,
      dataDir: '/Users/me/CamStack/data',
      override: undefined,
    }
    expect(classifyCoralAccelerator(fs, host)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 1 }],
    })
    expect(classifyCoralAccelerator(makeFs(), host)).toBeNull()
  })

  it('returns null when neither a Coral USB device nor the delegate is present', () => {
    const fs = makeFs({
      listUsbDevices: () => ['1-1'],
      readUsbAttr: (_d, attr) => (attr === 'idVendor' ? '8086' : '1234'),
    })
    expect(classifyCoralAccelerator(fs)).toBeNull()
  })
})

/**
 * PCIe / M.2 Coral: the gasket/apex driver exposes `/sys/class/apex/apex_N`
 * and `/dev/apex_N`; the PCI function `1ac1:089a` is visible under
 * `/sys/bus/pci/devices` with or without the driver.
 */
interface PciFixture {
  /** PCI functions with the Coral id. */
  readonly corals: number
  /** `/sys/class/apex` entries (the driver bound this many). */
  readonly apex: number
  /** Which `/dev/apex_N` exist in this process's view. */
  readonly devNodes?: readonly number[]
  /** Which `/dev/apex_N` open read/write. */
  readonly openable?: readonly number[]
  readonly usbCorals?: number
  readonly lib?: boolean
}

const IGPU = '0000:00:02.0'

function pciAttr(device: string, attr: string): string {
  if (device === IGPU) return attr === 'vendor' ? '0x8086' : '0x46a6'
  return attr === 'vendor' ? '0x1ac1' : '0x089a'
}

function pciFs(f: PciFixture): CoralFs {
  const pci = [...Array.from({ length: f.corals }, (_, i) => `0000:0${i + 3}:00.0`), IGPU]
  const usb = Array.from({ length: f.usbCorals ?? 0 }, (_, i) => `2-${i + 1}`)
  const devNodes = f.devNodes ?? Array.from({ length: f.apex }, (_, i) => i)
  const openable = f.openable ?? devNodes
  return makeFs({
    listUsbDevices: () => usb,
    readUsbAttr: usbIds('18d1', '9302'),
    listPciDevices: () => pci,
    readPciAttr: pciAttr,
    listApexClass: () => Array.from({ length: f.apex }, (_, i) => `apex_${i}`),
    exists: (p) =>
      (f.lib === true && p.endsWith('libedgetpu.so.1')) ||
      p.startsWith('/dev/bus/usb/') ||
      devNodes.some((n) => p === `/dev/apex_${n}`),
    canOpen: (p) => p.startsWith('/dev/bus/usb/') || openable.some((n) => p === `/dev/apex_${n}`),
  })
}

describe('classifyCoralAccelerator — PCIe / M.2', () => {
  it('no PCI Coral and no USB Coral → null', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 0, apex: 0 }))).toBeNull()
  })

  it('one PCIe unit with the driver bound and /dev/apex_0 openable → pci count 1', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 1, apex: 1 }))).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'pci', count: 1 }],
    })
  })

  it('two PCIe units → pci count 2', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 2, apex: 2 }))).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'pci', count: 2 }],
    })
  })

  it('PCI id present but no apex class → present, driver missing (never absent)', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 2, apex: 0 }))).toEqual({
      type: 'coral-edgetpu',
      units: [],
      unavailable: [{ bus: 'pci', count: 2, reason: 'driver-missing' }],
    })
  })

  it('driver missing does not invent a USB Coral from the installed delegate', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 1, apex: 0, lib: true }))).toEqual({
      type: 'coral-edgetpu',
      units: [],
      unavailable: [{ bus: 'pci', count: 1, reason: 'driver-missing' }],
    })
  })

  it('driver bound but /dev/apex_1 not openable (permissions) → device not accessible', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 2, apex: 2, openable: [0] }))).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'pci', count: 1 }],
      unavailable: [{ bus: 'pci', count: 1, reason: 'device-not-accessible' }],
    })
  })

  it('driver bound but no /dev/apex_N in this view (not passed through) → device not accessible', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 1, apex: 1, devNodes: [] }))).toEqual({
      type: 'coral-edgetpu',
      units: [],
      unavailable: [{ bus: 'pci', count: 1, reason: 'device-not-accessible' }],
    })
  })

  it('ignores a /sys/class/apex entry that is not apex_<N>', () => {
    const base = pciFs({ corals: 1, apex: 1 })
    const fs: CoralFs = {
      ...base,
      listApexClass: () => ['apex_0', 'apex_x', 'power'],
    }
    expect(classifyCoralAccelerator(fs)).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'pci', count: 1 }],
    })
  })

  it('mixed USB + PCIe → both buses, USB first', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 2, apex: 2, usbCorals: 1 }))).toEqual({
      type: 'coral-edgetpu',
      units: [
        { bus: 'usb', count: 1 },
        { bus: 'pci', count: 2 },
      ],
    })
  })

  it('mixed: a usable USB unit beside a driver-missing PCIe unit', () => {
    expect(classifyCoralAccelerator(pciFs({ corals: 1, apex: 0, usbCorals: 1 }))).toEqual({
      type: 'coral-edgetpu',
      units: [{ bus: 'usb', count: 1 }],
      unavailable: [{ bus: 'pci', count: 1, reason: 'driver-missing' }],
    })
  })
})

/**
 * The delegate fallback is evidence ONLY when the USB bus cannot be observed
 * (2026-10-23: the hub kept reporting `edgetpu:usb` after the stick moved to
 * another node, because the delegate stayed installed and the classifier
 * assumed a Coral although `/sys/bus/usb/devices` was readable and listed none).
 */
describe('detectCoralAccelerator — USB bus observability gates the delegate fallback', () => {
  const delegate = (p: string): boolean => p.endsWith('libedgetpu.so.1')
  const hostBus = ['usb1', '1-0:1.0', '1-1', '2-1']
  const nonCoral = (_d: string, attr: string): string => (attr === 'idVendor' ? '8086' : '1234')

  it('a readable bus with no Coral id and the delegate installed → no Coral, decided by the bus', () => {
    const fs = makeFs({
      listUsbDevices: () => hostBus,
      readUsbAttr: nonCoral,
      exists: delegate,
    })
    expect(classifyCoralAccelerator(fs)).toBeNull()
    expect(detectCoralAccelerator(fs)).toEqual({
      info: null,
      usbBus: 'observed',
      decidedBy: 'none',
      inaccessibleUsbNodes: [],
    })
  })

  it('an unreadable bus (null) with the delegate installed → one USB unit, decided by the fallback', () => {
    const fs = makeFs({ listUsbDevices: () => null, exists: delegate })
    expect(detectCoralAccelerator(fs)).toEqual({
      info: { type: 'coral-edgetpu', units: [{ bus: 'usb', count: 1 }] },
      usbBus: 'unobservable',
      decidedBy: 'delegate-fallback',
      inaccessibleUsbNodes: [],
    })
  })

  it('an empty bus listing counts as unobservable → fallback', () => {
    const fs = makeFs({ listUsbDevices: () => [], exists: delegate })
    expect(detectCoralAccelerator(fs).decidedBy).toBe('delegate-fallback')
  })

  it('a stick that re-enumerated as 18d1:9302 on an observed bus is found by its id', () => {
    const fs = makeFs({
      listUsbDevices: () => [...hostBus, '2-2'],
      readUsbAttr: (d, attr) => (d === '2-2' ? usbIds('18d1', '9302')(d, attr) : nonCoral(d, attr)),
      exists: (p) => delegate(p) || usbNodeAccessible.exists(p),
      canOpen: usbNodeAccessible.canOpen,
    })
    expect(detectCoralAccelerator(fs)).toEqual({
      info: { type: 'coral-edgetpu', units: [{ bus: 'usb', count: 1 }] },
      usbBus: 'observed',
      decidedBy: 'usb-ids',
      inaccessibleUsbNodes: [],
    })
  })

  it('a pre-firmware 1a6e:089a stick on an observed bus is found by its id', () => {
    const fs = makeFs({
      listUsbDevices: () => [...hostBus, '2-3'],
      readUsbAttr: (d, attr) => (d === '2-3' ? usbIds('1a6e', '089a')(d, attr) : nonCoral(d, attr)),
      ...usbNodeAccessible,
    })
    expect(detectCoralAccelerator(fs).decidedBy).toBe('usb-ids')
  })

  it('a PCIe unit decides by the PCI bus', () => {
    expect(detectCoralAccelerator(pciFs({ corals: 1, apex: 1, lib: true })).decidedBy).toBe('pci')
  })
})

/**
 * sysfs is the HOST's view: inside a container whose `/dev/bus/usb` mapping
 * was removed, `/sys/bus/usb/devices` still lists the stick (2026-10-23,
 * agent-b: `8-1`, `18d1:9302`). A USB Coral is usable only when its device
 * node `/dev/bus/usb/<BBB>/<DDD>` is in this process's view and opens
 * read/write — otherwise it is reported not accessible, with the path.
 */
describe('detectCoralAccelerator — a USB Coral counts only when its device node opens', () => {
  const STICK = '8-1'
  const NODE = '/dev/bus/usb/008/003'
  const sysfs = (d: string, attr: string): string => {
    if (d !== STICK) return attr === 'idVendor' ? '8086' : '1234'
    if (attr === 'idVendor') return '18d1'
    if (attr === 'idProduct') return '9302'
    if (attr === 'busnum') return '8'
    if (attr === 'devnum') return '3'
    return ''
  }
  const delegate = (p: string): boolean => p.endsWith('libedgetpu.so.1')
  const listed = (): readonly string[] => ['usb8', '8-0:1.0', STICK]
  const notAccessible = {
    type: 'coral-edgetpu',
    units: [],
    unavailable: [{ bus: 'usb', count: 1, reason: 'device-not-accessible' }],
  }

  it('listed and its node opens read/write → usable', () => {
    const fs = makeFs({
      listUsbDevices: listed,
      readUsbAttr: sysfs,
      exists: (p) => p === NODE,
      canOpen: (p) => p === NODE,
    })
    expect(detectCoralAccelerator(fs)).toEqual({
      info: { type: 'coral-edgetpu', units: [{ bus: 'usb', count: 1 }] },
      usbBus: 'observed',
      decidedBy: 'usb-ids',
      inaccessibleUsbNodes: [],
    })
  })

  it('listed but its node is not in this view (mapping removed) → not accessible, with the path', () => {
    const fs = makeFs({
      listUsbDevices: listed,
      readUsbAttr: sysfs,
      exists: delegate,
      canOpen: () => true,
    })
    expect(detectCoralAccelerator(fs)).toEqual({
      info: notAccessible,
      usbBus: 'observed',
      decidedBy: 'usb-ids',
      inaccessibleUsbNodes: [NODE],
    })
  })

  it('listed, node present but EACCES → not accessible, with the path', () => {
    const fs = makeFs({
      listUsbDevices: listed,
      readUsbAttr: sysfs,
      exists: (p) => p === NODE,
      canOpen: () => false,
    })
    expect(detectCoralAccelerator(fs)).toEqual({
      info: notAccessible,
      usbBus: 'observed',
      decidedBy: 'usb-ids',
      inaccessibleUsbNodes: [NODE],
    })
  })

  it('a listed stick whose sysfs entry has no busnum/devnum has no node to open → not accessible', () => {
    const fs = makeFs({
      listUsbDevices: listed,
      readUsbAttr: (d, attr) => (attr === 'busnum' || attr === 'devnum' ? '' : sysfs(d, attr)),
      exists: () => true,
      canOpen: () => true,
    })
    expect(detectCoralAccelerator(fs).info).toEqual(notAccessible)
  })

  it('one usable stick beside one whose node is missing → one unit each', () => {
    const fs = makeFs({
      listUsbDevices: () => ['2-4', STICK],
      readUsbAttr: (d, attr) => (d === '2-4' ? usbIds('18d1', '9302')(d, attr) : sysfs(d, attr)),
      exists: (p) => p === USB_NODE,
      canOpen: (p) => p === USB_NODE,
    })
    expect(detectCoralAccelerator(fs)).toMatchObject({
      info: {
        units: [{ bus: 'usb', count: 1 }],
        unavailable: [{ bus: 'usb', count: 1, reason: 'device-not-accessible' }],
      },
      inaccessibleUsbNodes: [NODE],
    })
  })
})
