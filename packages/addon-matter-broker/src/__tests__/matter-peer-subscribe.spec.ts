import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import { subscribableFromPeer } from '../matter-peer-subscribe.js'

interface WarnLine {
  readonly message: string
}

function recordingLogger(warns: WarnLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warns.push({ message })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/**
 * Like the real `ClientInteraction.subscribe`: it counts only the request
 * lists `Subscribe()` builds (`attributeRequests`, `eventRequests`), not the
 * raw `attributes` / `events` option names, and throws when both are empty.
 */
function strictSubscribe(requests: unknown[]): (request: unknown) => Promise<unknown> {
  return async (request) => {
    requests.push(request)
    const lists = isRecord(request) ? request : {}
    const attributes = lists['attributeRequests']
    const events = lists['eventRequests']
    const count =
      (Array.isArray(attributes) ? attributes.length : 0) +
      (Array.isArray(events) ? events.length : 0)
    if (count === 0) {
      throw new Error('When subscribing to attributes and events, at least one must be specified.')
    }
    return { close: async () => undefined }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A peer whose `stateOf` view is read-only, like matter.js's immutable view. */
function peerWithReadOnlyNetwork(
  options: { readonly setStateOfThrows: boolean },
  calls: unknown[][],
  requests: unknown[] = [],
): Record<string, unknown> {
  const readOnlyView = new Proxy(
    { autoSubscribe: true },
    {
      set: () => {
        throw new Error('This view is read-only')
      },
    },
  )
  return {
    lifecycle: { isOnline: true },
    stateOf: () => readOnlyView,
    setStateOf: async (...args: unknown[]) => {
      calls.push(args)
      if (options.setStateOfThrows) throw new Error('transaction failed')
    },
    interaction: { subscribe: strictSubscribe(requests) },
  }
}

const HANDLERS = { onReport: () => undefined, onEvent: () => undefined }

describe('subscribableFromPeer', () => {
  it('turns auto-subscribe off through setStateOf and still subscribes', async () => {
    const calls: unknown[][] = []
    const peer = subscribableFromPeer(
      peerWithReadOnlyNetwork({ setStateOfThrows: false }, calls),
      '1',
    )
    await expect(peer?.subscribe(HANDLERS)).resolves.toBeDefined()
    expect(calls).toEqual([['network', { autoSubscribe: false }]])
  })

  it('subscribes anyway, with a warn, when turning auto-subscribe off fails', async () => {
    const warns: WarnLine[] = []
    const peer = subscribableFromPeer(
      peerWithReadOnlyNetwork({ setStateOfThrows: true }, []),
      '1',
      recordingLogger(warns),
    )
    await expect(peer?.subscribe(HANDLERS)).resolves.toBeDefined()
    expect(warns).toHaveLength(1)
  })

  it('sends a request the library can count, with the sustained-subscription options', async () => {
    const requests: unknown[] = []
    const peer = subscribableFromPeer(
      peerWithReadOnlyNetwork({ setStateOfThrows: false }, [], requests),
      '1',
    )
    await peer?.subscribe(HANDLERS)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      sustain: true,
      bootstrapWithRead: true,
      keepSubscriptions: false,
      isFabricFiltered: true,
      attributeRequests: [{}],
      eventRequests: [{}],
    })
  })
})
