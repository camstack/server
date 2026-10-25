/**
 * Coral Edge TPU units — the ONE place a probed {@link CoralInfo} becomes
 * addressable units, and a unit's device-key suffix becomes the device string
 * the libedgetpu delegate is opened with. Pure: no I/O.
 *
 * Key suffix (what `edgetpu:<suffix>` carries, and what the pool's `device`
 * holds until the delegate opens):  `usb`, `usb:1`, …, `pci`, `pci:1`, …
 * The first unit of a bus keeps the bare bus name, so a node's first USB Coral
 * keeps the `edgetpu:usb` key every stored setting already uses.
 *
 * Delegate device string (libedgetpu's `device` option): ALWAYS an explicit
 * ordinal, `usb:0` / `usb:1` / `pci:0` / `pci:1`. A bare or omitted device
 * means "the first Edge TPU of any bus" to libedgetpu, which on a node with
 * both buses would let two pools open the same unit.
 */

import type { CoralBus, CoralInfo } from '../interfaces/platform.js'

/** One usable Coral unit: its bus, its ordinal on that bus, its key suffix. */
export interface CoralUnitAddress {
  readonly bus: CoralBus
  readonly index: number
  /** The device-key suffix: `usb`, `usb:1`, `pci`, `pci:1`, … */
  readonly device: string
}

/** Bus order of the enumeration: USB first (the historical key), then PCIe. */
const BUS_ORDER: readonly CoralBus[] = ['usb', 'pci']

function unitDevice(bus: CoralBus, index: number): string {
  return index === 0 ? bus : `${bus}:${index}`
}

function countOn(coral: CoralInfo, bus: CoralBus): number {
  if (coral.units !== undefined) {
    return coral.units.filter((u) => u.bus === bus).reduce((n, u) => n + Math.max(0, u.count), 0)
  }
  // Legacy report from an older node: one bus (always USB in practice), and an
  // omitted count meant "could not count — one Coral".
  const legacyBus: CoralBus = coral.bus === 'pci' ? 'pci' : 'usb'
  return bus === legacyBus ? Math.max(1, coral.count ?? 1) : 0
}

/** Every usable Coral unit on a node, USB first then PCIe, in ordinal order. */
export function coralUsableUnits(coral: CoralInfo | null | undefined): readonly CoralUnitAddress[] {
  if (coral == null) return []
  const out: CoralUnitAddress[] = []
  for (const bus of BUS_ORDER) {
    const count = countOn(coral, bus)
    for (let index = 0; index < count; index++) {
      out.push({ bus, index, device: unitDevice(bus, index) })
    }
  }
  return out
}

const KEY_DEVICE = /^(usb|pci)(?::(\d+))?$/

/**
 * Map an edgetpu key suffix (`usb`, `usb:1`, `pci`, `pci:1`) to the explicit
 * libedgetpu device string (`usb:0`, `usb:1`, `pci:0`, `pci:1`). Throws on any
 * other string — a pool must never open "whichever Edge TPU comes first".
 */
export function edgetpuDelegateDevice(device: string): string {
  const match = KEY_DEVICE.exec(device.trim())
  if (match === null) {
    throw new Error(`edgetpu device "${device}" is not usb[:N] or pci[:N]`)
  }
  const [, bus, ordinal] = match
  return `${bus}:${ordinal ?? '0'}`
}
