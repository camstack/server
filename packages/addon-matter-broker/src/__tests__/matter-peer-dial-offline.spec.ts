import { describe, expect, it } from 'vitest'
import { describeErrorChain } from '../matter-error-chain.js'
import { dialPeer } from '../matter-peer-subscribe.js'
import { SUBSCRIBE_ATTEMPT_TIMEOUT_MS } from '../matter-subscription.js'

/** The peer has been unreachable for two minutes: past matter.js's 90 s default. */
const TIME_OFFLINE_MS = 120_000
const REAL_DIAL_MS = 50

class PeerUnreachableError extends Error {
  constructor() {
    super('Peer unreachable')
    this.name = 'PeerUnreachableError'
  }
}
class AbortedError extends Error {
  constructor(cause: Error) {
    super('Operation aborted', { cause })
    this.name = 'AbortedError'
  }
}

interface ConnectOptions {
  readonly abort?: AbortSignal
  readonly kick?: boolean
  readonly connectionTimeout?: number
}

/** Mirrors matter.js Peer.connect: without `kick` the timeout is reduced by timeOffline. */
async function fakeConnect(options?: ConnectOptions): Promise<void> {
  let timeout = options?.connectionTimeout ?? 90_000
  if (options?.kick !== true) timeout -= TIME_OFFLINE_MS
  if (timeout <= 0) throw new AbortedError(new PeerUnreachableError())
  await new Promise((resolve) => setTimeout(resolve, REAL_DIAL_MS))
}

function nodeWith(connect: (options?: ConnectOptions) => Promise<void>): Record<string, unknown> {
  const protocolPeer = { kick: () => undefined, connect }
  return {
    env: { get: () => ({ get: () => protocolPeer }) },
    state: { commissioning: { peerAddress: { fabricIndex: 1, nodeId: 1n } } },
  }
}

describe('dialPeer on a peer that stayed offline', () => {
  it('really dials: kick + the per-attempt timeout, not the offline-reduced default', async () => {
    const dialed = await dialPeer(
      nodeWith(fakeConnect),
      new AbortController().signal,
      () => undefined,
    )
    expect(dialed).toBe(true)
  })

  it('passes the per-attempt timeout together with kick', async () => {
    let seen: ConnectOptions | undefined
    await dialPeer(
      nodeWith(async (options) => {
        seen = options
      }),
      new AbortController().signal,
      () => undefined,
    )
    expect(seen?.kick).toBe(true)
    expect(seen?.connectionTimeout).toBe(SUBSCRIBE_ATTEMPT_TIMEOUT_MS)
  })

  it('the old options fail at once with the real reason hidden in the cause', async () => {
    const err = await fakeConnect({ abort: new AbortController().signal }).catch((e: unknown) => e)
    expect(describeErrorChain(err)).toBe(
      'Operation aborted <- PeerUnreachableError: Peer unreachable',
    )
  })
})

describe('describeErrorChain', () => {
  it('names a lone error and a non-error value', () => {
    expect(describeErrorChain(new Error('boom'))).toBe('boom')
    expect(describeErrorChain('text')).toBe('text')
  })
})
