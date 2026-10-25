/**
 * A node read must reach the HUB's device-history, whatever node it is about.
 *
 * Cap routing reads a top-level `nodeId` as "run this on that node". The node
 * reads used to name their subject `nodeId`, so `queryNode({ nodeId:
 * 'agent-a' })` was routed to agent-a — which hosts no
 * device-history — and failed "device-history not available on node". The
 * subject is `forNodeId` (as `metrics.getLoadSeries` names it), and no
 * device-history method may declare a top-level `nodeId` again.
 */
import { deviceHistoryCapability, expandCapMethods } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildOneCapRouter,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../../../kernel/cap-router-builder.js'

interface Proc {
  readonly call: (input: unknown) => unknown
}

function isProc(value: unknown): value is Proc {
  return typeof value === 'object' && value !== null && 'call' in value
}

function builder(): ProcedureBuilder {
  let schema: z.ZodType | null = null
  const b: ProcedureBuilder = {
    input(s) {
      schema = s instanceof z.ZodType ? s : null
      return b
    },
    output() {
      return b
    },
    query(resolver) {
      const parse = schema
      return {
        call: (input: unknown) => resolver({ input: parse ? parse.parse(input) : input, ctx: {} }),
      }
    },
    mutation(resolver) {
      const parse = schema
      return {
        call: (input: unknown) => resolver({ input: parse ? parse.parse(input) : input, ctx: {} }),
      }
    },
    subscription(resolver) {
      return { call: (input: unknown) => resolver({ input, ctx: {} }) }
    },
  }
  return b
}

const primitives: CapRouterPrimitives = {
  router: (procs) => procs,
  procedures: { public: builder(), protected: builder(), admin: builder() },
  iterableSubscription: () => (async function* () {})(),
}

describe('device-history node reads route to the hub', () => {
  it('no device-history method declares a top-level `nodeId` (the routing key)', () => {
    for (const [name, method] of Object.entries(expandCapMethods(deviceHistoryCapability))) {
      const input = method.input
      if (!(input instanceof z.ZodObject)) continue
      expect(Object.keys(input.shape), `${name} input`).not.toContain('nodeId')
    }
  })

  it('queryNode / listNodeSeries for an AGENT node are served by the hub-local provider', async () => {
    const seen: { method: string; input: unknown }[] = []
    const remote: string[] = []
    const local = new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop === 'string'
            ? (input: unknown) => {
                seen.push({ method: prop, input })
                return prop === 'listNodeSeries'
                  ? []
                  : { resolution: '5m', series: [], truncated: false }
              }
            : undefined,
      },
    )
    const services: CapRouterServices = {
      getLocalProvider: () => local,
      remoteProxy: (_cap, nodeId) => {
        remote.push(nodeId)
        return null
      },
      noProvider: (cap, nodeId) => {
        throw new Error(`${cap} not available on node ${nodeId ?? 'hub'}`)
      },
      noNodeRouting: (cap) => {
        throw new Error(`noNodeRouting:${cap}`)
      },
      badRequest: (m) => {
        throw new Error(m)
      },
    }
    const router = buildOneCapRouter(deviceHistoryCapability, primitives, services)
    if (typeof router !== 'object' || router === null) throw new Error('no router')
    const queryNode: unknown = Reflect.get(router, 'queryNode')
    const listNodeSeries: unknown = Reflect.get(router, 'listNodeSeries')
    if (!isProc(queryNode) || !isProc(listNodeSeries)) throw new Error('procedures missing')

    await queryNode.call({
      forNodeId: 'agent-a',
      key: 'addon:metrics-native/node-cpu-percent',
      from: 0,
      to: 1,
    })
    await listNodeSeries.call({ forNodeId: 'agent-a' })

    expect(remote).toEqual([])
    expect(seen.map((s) => s.method)).toEqual(['queryNode', 'listNodeSeries'])
    expect(seen[0]?.input).toMatchObject({ forNodeId: 'agent-a' })
    expect(seen[1]?.input).toEqual({ forNodeId: 'agent-a' })
  })
})
