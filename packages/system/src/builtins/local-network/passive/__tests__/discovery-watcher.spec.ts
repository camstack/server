import type { DiscoveryObservation, IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DiscoveryWatcher,
  FLUSH_INTERVAL_MS,
  type PassiveListenIo,
  type PassivePacket,
  SWEEP_INTERVAL_MS,
} from '../discovery-watcher.js'
import { parseSsdpPacket } from '../passive-packets.js'

class QuietLogger implements IScopedLogger {
  warn = vi.fn<(message: string, extras?: LogExtras) => void>()
  info(): void {}
  debug(): void {}
  error(): void {}
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

function notify(from: string, nt: string): PassivePacket {
  const data = Buffer.from(
    `NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: ${nt}\r\nNTS: ssdp:alive\r\nUSN: uuid:1\r\n\r\n`,
  )
  return { protocol: 'ssdp', data, from }
}

function setup() {
  let deliver: (packet: PassivePacket) => void = () => {}
  const open = vi.fn(async (onPacket: (p: PassivePacket) => void) => {
    deliver = onPacket
    return { close: vi.fn() }
  })
  const io: PassiveListenIo = { open }
  const report = vi.fn(async (_o: readonly DiscoveryObservation[]) => {})
  const sweep = vi.fn(async () => {})
  const watcher = new DiscoveryWatcher({
    io,
    sink: { report, sweep },
    logger: new QuietLogger(),
  })
  return { watcher, open, report, sweep, hear: (p: PassivePacket) => deliver(p) }
}

describe('DiscoveryWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the sweep is bounded by the 30-minute schedule', async () => {
    const { watcher, sweep } = setup()
    await watcher.start({ passive: false })
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1)
    expect(sweep).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2)
    expect(sweep).toHaveBeenCalledTimes(3)
    await watcher.stop()
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2)
    expect(sweep).toHaveBeenCalledTimes(3)
  })

  it('never runs two sweeps at once', async () => {
    const { watcher, sweep } = setup()
    let release: () => void = () => {}
    sweep.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    await watcher.start({ passive: false })
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2)
    expect(sweep).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('passive off opens no listener and reports nothing', async () => {
    const { watcher, open, report } = setup()
    await watcher.start({ passive: false })
    expect(open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3)
    expect(report).not.toHaveBeenCalled()
  })

  it('batches what it hears and reports a repeated sighting once', async () => {
    const { watcher, report, hear } = setup()
    await watcher.start({ passive: true })
    hear(notify('192.0.2.7', 'urn:schemas-upnp-org:device:MediaRenderer:1'))
    hear(notify('192.0.2.7', 'urn:schemas-upnp-org:device:MediaRenderer:1'))
    hear(notify('192.0.2.8', 'urn:schemas-upnp-org:device:MediaRenderer:1'))
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]?.[0].map((o) => o.host)).toEqual(['192.0.2.7', '192.0.2.8'])

    hear(notify('192.0.2.7', 'urn:schemas-upnp-org:device:MediaRenderer:1'))
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('a failed hand-over is said, not thrown', async () => {
    const { watcher, report, hear } = setup()
    report.mockRejectedValueOnce(new Error('hub busy'))
    await watcher.start({ passive: true })
    hear(notify('192.0.2.7', 'upnp:rootdevice'))
    await expect(vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)).resolves.not.toThrow()
  })
})

describe('parseSsdpPacket', () => {
  it('ignores a search request and a byebye', () => {
    const search = Buffer.from('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n')
    expect(parseSsdpPacket(search, '192.0.2.1')).toBeNull()
    const bye = Buffer.from('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\nNTS: ssdp:byebye\r\n\r\n')
    expect(parseSsdpPacket(bye, '192.0.2.1')).toBeNull()
  })
})
