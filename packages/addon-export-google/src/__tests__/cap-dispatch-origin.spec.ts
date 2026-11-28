import type { AddonApi } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { dispatchCapCall } from '../google-home/cap-dispatch.js'

/** The one mutate this spec exercises; the rest of the api is never touched. */
interface SwitchOnlyApi {
  readonly switch: {
    readonly setState: {
      readonly mutate: (input: unknown, opts?: unknown) => Promise<void>
    }
  }
}

function recordingApi(): { api: AddonApi; opts: unknown[] } {
  const opts: unknown[] = []
  const fake: SwitchOnlyApi = {
    switch: {
      setState: {
        mutate: async (_input, o) => {
          opts.push(o)
        },
      },
    },
  }
  // boundary: the generated AddonApi is too wide to fake without a cast
  return { api: fake as unknown as AddonApi, opts }
}

const CALL = { kind: 'switch.setState', deviceId: 5, on: true } as const

describe('google dispatch names the linked account', () => {
  it('attaches an on-behalf claim for the account that asked', async () => {
    const { api, opts } = recordingApi()
    await dispatchCapCall(api, CALL, {
      principalId: 'u1',
      principalName: 'Ada',
    })
    expect(Object.values(Reflect.get(opts[0] as object, 'context'))).toEqual([
      {
        kind: 'on-behalf',
        source: 'google',
        principalId: 'u1',
        principalName: 'Ada',
      },
    ])
  })

  it('attaches nothing when no account is known', async () => {
    const { api, opts } = recordingApi()
    await dispatchCapCall(api, CALL, { principalId: '' })
    expect(opts[0]).toBeUndefined()
  })
})
