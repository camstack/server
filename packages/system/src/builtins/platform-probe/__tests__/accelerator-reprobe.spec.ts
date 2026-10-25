/**
 * The accelerator re-probe (D919): a Coral pulled out or plugged in while the
 * process runs changes the node's inference device list without a restart.
 * The full probe runs once; `reprobeAccelerators` re-reads only `/sys` and
 * `/dev` and rebuilds the device enumeration from the new Coral answer.
 */
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = Object.assign(() => undefined, {
    [promisify.custom]: async () => {
      throw new Error('no subprocess in this spec')
    },
  })
  return { ...actual, execFile }
})

import type { CoralFs } from '../coral-accelerators.js'
import { PlatformScorer } from '../platform-scorer.js'
import { diffInferenceDevices } from '../accelerator-reprobe.js'

interface LoggedLine {
  readonly msg: string
  readonly meta: unknown
}

function recordingLogger(lines: LoggedLine[]): IScopedLogger {
  const push = (msg: string, opts?: { meta?: unknown }): void => {
    lines.push({ msg, meta: opts?.meta })
  }
  const l: IScopedLogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => l,
    withTags: () => l,
  }
  return l
}

const STICK_NODE = '/dev/bus/usb/002/005'

const STICK_ATTRS: Readonly<Record<string, string>> = {
  idVendor: '18d1',
  idProduct: '9302',
  busnum: '2',
  devnum: '5',
}

/** What {@link usbHost} hands a spec: the fake view and its two switches. */
interface UsbHost {
  readonly fs: CoralFs
  /** Whether the stick is on the bus at all. */
  readonly plug: (on: boolean) => void
  /** Whether its `/dev/bus/usb` node is passed into this view (sysfs lists it either way). */
  readonly map: (on: boolean) => void
}

/** A host whose USB bus is readable, with one Coral stick on it. */
function usbHost(): UsbHost {
  let plugged = true
  let mapped = true
  const fs: CoralFs = {
    listUsbDevices: () => (plugged ? ['usb1', '1-1', '2-2'] : ['usb1', '1-1']),
    readUsbAttr: (device, attr) =>
      device === '2-2' ? (STICK_ATTRS[attr] ?? '') : attr === 'idVendor' ? '8086' : '1',
    listPciDevices: () => [],
    readPciAttr: () => '',
    listApexClass: () => [],
    canOpen: (p) => mapped && p === STICK_NODE,
    // The delegate stays installed after the stick leaves — the 2026-10-23 hub.
    exists: (p) => p.endsWith('libedgetpu.so.1') || (mapped && p === STICK_NODE),
  }
  return { fs, plug: (on) => (plugged = on), map: (on) => (mapped = on) }
}

const edgetpuKeys = (keys: readonly { key: string }[]): string[] =>
  keys.map((d) => d.key).filter((k) => k.startsWith('edgetpu'))

describe('PlatformScorer.reprobeAccelerators', () => {
  it('is null before the first full probe', () => {
    expect(new PlatformScorer(undefined, null, usbHost().fs).reprobeAccelerators()).toBeNull()
  })

  it('a stick pulled out disappears from the device list; plugged back, it reappears', async () => {
    const host = usbHost()
    const lines: LoggedLine[] = []
    const scorer = new PlatformScorer(recordingLogger(lines), null, host.fs)
    const first = await scorer.probe()
    expect(edgetpuKeys(first.devices)).toEqual(['edgetpu:usb'])

    // Nothing moved: no change, no log line on the periodic cadence.
    const quiet = scorer.reprobeAccelerators()
    expect(quiet?.change).toEqual({ appeared: [], disappeared: [] })
    expect(lines.some((l) => l.msg === 'Coral Edge TPU probe changed')).toBe(false)

    host.plug(false)
    const gone = scorer.reprobeAccelerators()
    expect(gone?.change).toEqual({
      appeared: [],
      disappeared: ['edgetpu:usb'],
    })
    expect(gone?.detection).toMatchObject({
      usbBus: 'observed',
      decidedBy: 'none',
    })
    expect(edgetpuKeys(gone!.caps.devices)).toEqual([])
    // The cached capabilities the provider serves follow the re-probe.
    expect(edgetpuKeys((await scorer.probe()).devices)).toEqual([])
    expect((await scorer.probe()).hardware.coral).toBeNull()
    expect(lines.some((l) => l.msg === 'Coral Edge TPU probe changed')).toBe(true)

    host.plug(true)
    const back = scorer.reprobeAccelerators()
    expect(back?.change).toEqual({
      appeared: ['edgetpu:usb'],
      disappeared: [],
    })
    expect(edgetpuKeys((await scorer.probe()).devices)).toEqual(['edgetpu:usb'])
  })
})

describe('PlatformScorer.reprobeAccelerators — a stick whose /dev/bus/usb mapping was removed', () => {
  it('leaves the device list although sysfs still lists it, and the change names the path once', async () => {
    const host = usbHost()
    const lines: LoggedLine[] = []
    const scorer = new PlatformScorer(recordingLogger(lines), null, host.fs)
    expect(edgetpuKeys((await scorer.probe()).devices)).toEqual(['edgetpu:usb'])

    host.map(false)
    const unmapped = scorer.reprobeAccelerators()
    expect(unmapped?.change).toEqual({
      appeared: [],
      disappeared: ['edgetpu:usb'],
    })
    expect(unmapped?.detection).toMatchObject({
      usbBus: 'observed',
      decidedBy: 'usb-ids',
      inaccessibleUsbNodes: [STICK_NODE],
    })
    const changed = lines.filter((l) => l.msg === 'Coral Edge TPU probe changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]!.meta).toMatchObject({
      inaccessibleUsbNodes: [STICK_NODE],
    })

    // Unchanged on the next tick: no second line.
    scorer.reprobeAccelerators()
    expect(lines.filter((l) => l.msg === 'Coral Edge TPU probe changed')).toHaveLength(1)

    host.map(true)
    expect(scorer.reprobeAccelerators()?.change).toEqual({
      appeared: ['edgetpu:usb'],
      disappeared: [],
    })
  })
})

describe('diffInferenceDevices', () => {
  const d = (key: string) => ({
    key,
    backend: 'x',
    device: 'x',
    format: 'onnx' as const,
    runtime: 'python' as const,
    score: 1,
    available: true,
  })
  it('names appeared and disappeared keys, sorted', () => {
    expect(
      diffInferenceDevices([d('cpu'), d('edgetpu:usb')], [d('edgetpu:pci'), d('cpu')]),
    ).toEqual({
      appeared: ['edgetpu:pci'],
      disappeared: ['edgetpu:usb'],
    })
  })
})
