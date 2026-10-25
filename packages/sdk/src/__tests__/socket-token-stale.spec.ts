/**
 * The WebSocket authenticates once, at the handshake. A token rotated (or
 * first obtained) after that leaves the socket answering UNAUTHORIZED until
 * it is re-handshaken, so the System reports it as stale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { System } from '../system.js'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
      for (const fn of this.listeners.get('open') ?? []) fn()
    }, 0)
  }
  send(): void {}
  close(): void {
    this.readyState = 3
  }
  private listeners = new Map<string, Array<() => void>>()
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeSocket.instances = []
})

describe('System.isSocketTokenStale', () => {
  it('flags a socket handshaken with the old token after setToken, and clears on reconnect', async () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    const sys = new System({ serverUrl: 'http://hub.test', token: 'old', useWebSocket: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(sys.isSocketTokenStale()).toBe(false)
    sys.setToken('new')
    expect(sys.isSocketTokenStale()).toBe(true)
    sys.reconnect()
    await new Promise((r) => setTimeout(r, 10))
    expect(sys.isSocketTokenStale()).toBe(false)
    sys.close()
  })

  it('is never stale over HTTP', () => {
    const sys = new System({ serverUrl: 'http://hub.test', token: 'old', useWebSocket: false })
    sys.setToken('new')
    expect(sys.isSocketTokenStale()).toBe(false)
  })
})
