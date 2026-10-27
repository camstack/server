import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

/** Ports the fake proxies currently hold — freed only by `stopProxyServer`. */
const heldPorts = new Set<number>()

vi.mock('alexa-remote2', () => {
  class FakeAlexaRemote {
    #port = 0
    on(): this {
      return this
    }
    init(opts: { proxyPort: number }, cb: (err?: Error) => void): void {
      if (heldPorts.has(opts.proxyPort)) {
        cb(new Error('Proxy Server could not be initialized'))
        return
      }
      heldPorts.add(opts.proxyPort)
      this.#port = opts.proxyPort
      cb(new Error(`Please open http://h:${opts.proxyPort}/ with your browser and login`))
    }
    // Like alexa-remote2: stop() clears timers only, the proxy stays bound.
    stop(): void {}
    stopProxyServer(cb?: () => void): void {
      heldPorts.delete(this.#port)
      cb?.()
    }
  }
  return { default: FakeAlexaRemote }
})

import { VendorLoginProxy } from '@camstack/types'
import { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as IScopedLogger

const loginProxy = new VendorLoginProxy({ addonId: 'import-alexa', logger })

function mkManager(): AlexaProxyLoginManager {
  return new AlexaProxyLoginManager({
    logger,
    getProxyConfig: () => ({ proxyPort: 3456 }),
    getLoginProxy: () => loginProxy,
  })
}

describe('proxy login restart', () => {
  beforeEach(() => heldPorts.clear())

  it('start → cancel → start again binds the proxy again', async () => {
    const m = mkManager()
    const first = await m.start('amazon.it')
    expect(m.status(first.sessionId)?.phase).toBe('awaiting-login')
    await m.cancel(first.sessionId)
    expect(heldPorts.size).toBe(0)
    const second = await m.start('amazon.it')
    expect(m.status(second.sessionId)?.phase).toBe('awaiting-login')
    await m.dispose()
  })

  it('a failed init does not leave its own hold behind', async () => {
    heldPorts.add(3456) // someone else holds it: init reports failure
    const m = mkManager()
    const r = await m.start('amazon.it')
    expect(m.status(r.sessionId)?.phase).toBe('error')
    heldPorts.delete(3456)
    const again = await m.start('amazon.it')
    expect(m.status(again.sessionId)?.phase).toBe('awaiting-login')
    await m.dispose()
  })
})
