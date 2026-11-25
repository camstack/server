import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
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

/** A peer whose `stateOf` view is read-only, like matter.js's immutable view. */
function peerWithReadOnlyNetwork(
  options: { readonly setStateOfThrows: boolean },
  calls: unknown[][],
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
    interaction: { subscribe: async () => ({ close: async () => undefined }) },
  }
}

const HANDLERS = { onReport: () => undefined, onEvent: () => undefined, onClosed: () => undefined }

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
})
