/**
 * The DeferredResponse helper (D869): sync answer when the actuator is already
 * there, DeferredResponse + asynchronous Response when it arrives later, an
 * asynchronous ErrorResponse at the timeout, and a read that fails while
 * waiting is one poll lost - never an arrival, never a failure.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildAsyncResponsePayload,
  DEFERRAL_TIMEOUT_MS,
  type AsyncResponseInput,
  type DeferralPlan,
  runWithDeferral,
} from '../handlers/deferred-response.js'
import { quietLogger } from './helpers/fake-device-api.js'

const header = {
  namespace: 'Alexa.RangeController',
  name: 'SetRangeValue',
  payloadVersion: '3',
  messageId: 'm1',
  correlationToken: 'tok',
}

function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

function plan(read: DeferralPlan['read'], command = async () => {}): DeferralPlan {
  return {
    header,
    endpointId: '9__dev',
    userId: 'u1',
    deviceId: 9,
    command,
    read,
    commandErrorType: 'ENDPOINT_UNREACHABLE',
  }
}

const reading = (reached: boolean) => ({
  properties: [
    {
      namespace: 'Alexa.RangeController',
      instance: 'Blind.Position',
      name: 'rangeValue',
      value: 5,
    },
  ],
  reached,
})

describe('runWithDeferral', () => {
  it('an actuator already at the target answers a plain Response', async () => {
    const send = vi.fn(async (_input: AsyncResponseInput) => true)
    const { body, settled } = await runWithDeferral(
      plan(async () => reading(true)),
      {
        sendAsyncResponse: send,
        logger: quietLogger,
        ...clock(),
      },
    )
    expect((body as { event: { header: { name: string } } }).event.header.name).toBe('Response')
    expect(settled).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('a slow actuator: DeferredResponse now with the correlation token, Response when it arrives', async () => {
    let reads = 0
    const send = vi.fn(async (_input: AsyncResponseInput) => true)
    const { body, settled } = await runWithDeferral(
      plan(async () => reading(++reads > 8)),
      { sendAsyncResponse: send, logger: quietLogger, ...clock() },
    )
    const event = (body as { event: { header: Record<string, string>; payload: unknown } }).event
    expect(event.header['name']).toBe('DeferredResponse')
    expect(event.header['correlationToken']).toBe('tok')
    expect(event.payload).toEqual({ estimatedDeferralInSeconds: 30 })
    await settled
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationToken: 'tok',
        endpointId: '9__dev',
        outcome: expect.objectContaining({ kind: 'response' }),
      }),
    )
  })

  it('an actuator that never arrives ends in an asynchronous ErrorResponse at the timeout', async () => {
    const send = vi.fn(async (_input: AsyncResponseInput) => true)
    const c = clock()
    const { settled } = await runWithDeferral(
      plan(async () => reading(false)),
      {
        sendAsyncResponse: send,
        logger: quietLogger,
        ...c,
      },
    )
    await settled
    expect(c.now()).toBeGreaterThanOrEqual(DEFERRAL_TIMEOUT_MS)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      outcome: { kind: 'error', type: 'INTERNAL_ERROR' },
    })
  })

  it('a read that throws while waiting is one poll lost, not an arrival and not a failure', async () => {
    let reads = 0
    const send = vi.fn(async (_input: AsyncResponseInput) => true)
    const { settled } = await runWithDeferral(
      plan(async () => {
        reads += 1
        if (reads < 6) throw new Error('mirror busy')
        return reading(true)
      }),
      { sendAsyncResponse: send, logger: quietLogger, ...clock() },
    )
    await settled
    expect(send.mock.calls[0]?.[0]).toMatchObject({ outcome: { kind: 'response' } })
  })

  it('a refused command is answered at once and nothing is deferred', async () => {
    const send = vi.fn(async (_input: AsyncResponseInput) => true)
    const { body, settled } = await runWithDeferral(
      plan(
        async () => reading(true),
        async () => {
          throw new Error('offline')
        },
      ),
      { sendAsyncResponse: send, logger: quietLogger, ...clock() },
    )
    expect((body as { event: { payload: { type: string } } }).event.payload.type).toBe(
      'ENDPOINT_UNREACHABLE',
    )
    expect(settled).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('asynchronous response payload', () => {
  it('carries the bearer scope, the correlation token and the instanced property', () => {
    const body = buildAsyncResponsePayload({
      endpointId: '9__dev',
      correlationToken: 'tok',
      accessToken: 'AT',
      outcome: { kind: 'response', properties: reading(true).properties },
    }) as {
      event: { header: Record<string, string>; endpoint: unknown }
      context: { properties: Array<Record<string, unknown>> }
    }
    expect(body.event.header).toMatchObject({ name: 'Response', correlationToken: 'tok' })
    expect(body.event.endpoint).toEqual({
      scope: { type: 'BearerToken', token: 'AT' },
      endpointId: '9__dev',
    })
    expect(body.context.properties[0]).toMatchObject({
      namespace: 'Alexa.RangeController',
      instance: 'Blind.Position',
      name: 'rangeValue',
    })
  })
})
