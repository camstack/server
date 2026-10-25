import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  type FulfillmentDeps,
  handleFulfillment,
  type VerifiedGoogleCaller,
} from '../fulfillment-router.js'
import { readBearer } from '../http-server.js'
import { createFakeGateway, facts, RecordingLogger, statusKey } from './fakes.js'

const LAMP = facts({ deviceId: 101, name: 'Lamp', deviceType: 'light', capNames: ['switch'] })

const READ_ONLY: readonly TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]
const READ_WRITE: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

function caller(scopes: readonly TokenScope[]): VerifiedGoogleCaller {
  return { userId: 'user-1', username: 'operator', scopes }
}

interface Harness {
  readonly deps: FulfillmentDeps
  readonly logger: RecordingLogger
  readonly linked: string[]
  readonly unlinked: string[]
  readonly dispatched: () => readonly string[]
}

function harness(): Harness {
  const logger = new RecordingLogger()
  const gateway = createFakeGateway({
    devices: { 101: LAMP },
    statuses: { [statusKey('switch', 101)]: { on: false, lastChangedAt: 1 } },
  })
  const linked: string[] = []
  const unlinked: string[] = []
  const deps: FulfillmentDeps = {
    logger,
    sync: { gateway, logger, listExposed: () => [101] },
    query: { gateway, logger, isExposed: () => true },
    execute: { gateway, logger, isExposed: () => true },
    recordLink: async (c) => {
      linked.push(c.userId)
    },
    removeLink: async (userId) => {
      unlinked.push(userId)
    },
  }
  return { deps, logger, linked, unlinked, dispatched: () => gateway.dispatched.map((c) => c.kind) }
}

describe('handleFulfillment', () => {
  it('answers SYNC and records the link', async () => {
    const h = harness()
    const result = await handleFulfillment(
      { requestId: 'r1', inputs: [{ intent: 'action.devices.SYNC' }] },
      h.deps,
      caller(READ_ONLY),
    )
    expect(result.status).toBe(200)
    expect(result.body.requestId).toBe('r1')
    expect(result.body.payload).toMatchObject({ agentUserId: 'user-1' })
    expect(h.linked).toEqual(['user-1'])
  })

  it('answers QUERY', async () => {
    const h = harness()
    const result = await handleFulfillment(
      {
        requestId: 'r2',
        inputs: [{ intent: 'action.devices.QUERY', payload: { devices: [{ id: '101' }] } }],
      },
      h.deps,
      caller(READ_ONLY),
    )
    expect(result.body.payload).toEqual({
      devices: { '101': { online: true, status: 'SUCCESS', on: false } },
    })
  })

  it('refuses EXECUTE on a view-only token and actuates nothing', async () => {
    const h = harness()
    const result = await handleFulfillment(
      {
        requestId: 'r3',
        inputs: [
          {
            intent: 'action.devices.EXECUTE',
            payload: {
              commands: [
                {
                  devices: [{ id: '101' }],
                  execution: [{ command: 'action.devices.commands.OnOff', params: { on: true } }],
                },
              ],
            },
          },
        ],
      },
      h.deps,
      caller(READ_ONLY),
    )
    expect(result.body.payload).toMatchObject({ errorCode: 'authFailure' })
    expect(h.dispatched()).toEqual([])
  })

  it('performs EXECUTE on a read-write token', async () => {
    const h = harness()
    const result = await handleFulfillment(
      {
        requestId: 'r4',
        inputs: [
          {
            intent: 'action.devices.EXECUTE',
            payload: {
              commands: [
                {
                  devices: [{ id: '101' }],
                  execution: [{ command: 'action.devices.commands.OnOff', params: { on: true } }],
                },
              ],
            },
          },
        ],
      },
      h.deps,
      caller(READ_WRITE),
    )
    expect(result.status).toBe(200)
    expect(h.dispatched()).toEqual(['switch.setState'])
  })

  it('drops the linked account on DISCONNECT', async () => {
    const h = harness()
    const result = await handleFulfillment(
      { requestId: 'r5', inputs: [{ intent: 'action.devices.DISCONNECT' }] },
      h.deps,
      caller(READ_WRITE),
    )
    expect(result.body.payload).toEqual({})
    expect(h.unlinked).toEqual(['user-1'])
  })

  it('rejects a body that is not a fulfillment request', async () => {
    const h = harness()
    const result = await handleFulfillment({ hello: 'world' }, h.deps, caller(READ_WRITE))
    expect(result.status).toBe(400)
    expect(result.body.payload).toMatchObject({ errorCode: 'protocolError' })
  })

  it('rejects an unknown intent rather than treating it as SYNC', async () => {
    const h = harness()
    const result = await handleFulfillment(
      { requestId: 'r6', inputs: [{ intent: 'action.devices.REBOOT' }] },
      h.deps,
      caller(READ_WRITE),
    )
    expect(result.status).toBe(400)
    expect(h.linked).toEqual([])
  })
})

describe('readBearer', () => {
  it('reads the token case-insensitively', () => {
    expect(readBearer({ Authorization: 'Bearer abc.def' })).toBe('abc.def')
    expect(readBearer({ authorization: 'bearer abc.def' })).toBe('abc.def')
  })

  it('returns null when there is no bearer', () => {
    expect(readBearer({})).toBeNull()
    expect(readBearer({ authorization: 'Basic dXNlcjpwdw==' })).toBeNull()
  })
})
