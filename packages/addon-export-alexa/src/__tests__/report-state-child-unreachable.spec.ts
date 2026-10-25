/**
 * A child accessory whose `switch` cannot be read — measured 2026-10-08: the
 * siren / floodlight / PIR children of sleeping Reolink battery cameras are
 * not spawned until the camera wakes, so `switch.getStatus` has no provider.
 * Alexa still holds those endpoints and polls them.
 *
 * The answer is `ENDPOINT_UNREACHABLE` (true: the accessory cannot be reached
 * now), not an empty StateReport, and the hub log gets one warning per child
 * per window instead of two per poll.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { handleReportState } from '../handlers/report-state.js'

const HEADER = {
  namespace: 'Alexa',
  name: 'ReportState',
  payloadVersion: '3',
  messageId: 'm1',
  correlationToken: 'c1',
}
const CALLER = { userId: 'u', username: 'u', scopes: [] }

function logger(): { logger: IScopedLogger; warns: string[] } {
  const warns: string[] = []
  const l: IScopedLogger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (msg: string) => {
      warns.push(msg)
    },
    withTags: () => l,
    child: () => l,
  }
  return { logger: l, warns }
}

function ctx(switchStatus: () => Promise<unknown>): AddonContext {
  return {
    api: {
      switch: { getStatus: { query: switchStatus } },
      brightness: { getStatus: { query: async () => null } },
    },
  } as unknown as AddonContext
}

describe('ReportState on a child accessory', () => {
  it('ENDPOINT_UNREACHABLE when its switch has no provider', async () => {
    const { logger: l } = logger()
    const res = (await handleReportState(
      HEADER,
      { endpointId: '3628__3632' },
      {
        ctx: ctx(async () => {
          throw new Error('no provider registered for device-native cap "switch" on device 3632')
        }),
        logger: l,
      },
      CALLER,
    )) as { event: { header: { name: string }; payload: { type?: string } } }
    expect(res.event.header.name).toBe('ErrorResponse')
    expect(res.event.payload.type).toBe('ENDPOINT_UNREACHABLE')
  })

  it('one warning per child per window, not two per poll', async () => {
    const { logger: l, warns } = logger()
    const deps = {
      ctx: ctx(async () => {
        throw new Error('no provider')
      }),
      logger: l,
    }
    for (let i = 0; i < 5; i += 1) {
      await handleReportState(HEADER, { endpointId: '3629__3635' }, deps, CALLER)
    }
    expect(warns).toHaveLength(1)
  })

  it('a readable switch still answers its powerState', async () => {
    const { logger: l } = logger()
    const res = (await handleReportState(
      HEADER,
      { endpointId: '640__641' },
      { ctx: ctx(async () => ({ on: true })), logger: l },
      CALLER,
    )) as { context: { properties: Array<{ name: string; value: unknown }> } }
    expect(res.context.properties).toContainEqual(
      expect.objectContaining({ name: 'powerState', value: 'ON' }),
    )
  })
})
