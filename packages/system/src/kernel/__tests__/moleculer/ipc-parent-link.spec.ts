import { describe, it, expect, vi } from 'vitest'
import { observable } from '@trpc/server/observable'
import { createTRPCClient } from '@trpc/client'
import { nodePin } from '@camstack/types'
import { ipcParentLink } from '../../moleculer/trpc-links.js'
import { UDS_NO_ROUTE_PREFIX } from '../../transport/local-child-registry.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'

/** Drive a single op through ipcParentLink; `next` is the fallback (broker) link. */
function runOp(
  getCallOut: () => ((input: CapCallInput) => Promise<unknown>) | null,
  path: string,
  input: unknown,
  next?: (op: unknown) => unknown,
): { promise: Promise<unknown>; nextCalled: boolean; nextCallArg: unknown } {
  const state = { nextCalled: false, nextCallArg: undefined as unknown }
  const fallback =
    next ??
    (() =>
      observable((observer) => {
        observer.next({ result: { type: 'data', data: 'BROKER_FALLBACK' } })
        observer.complete()
        return () => {}
      }))

  const wrappedNext = (op: unknown): unknown => {
    state.nextCalled = true
    state.nextCallArg = op
    return fallback(op)
  }

  const link = ipcParentLink(getCallOut)({} as never)
  const promise = new Promise<unknown>((resolve, reject) => {
    link({
      op: { id: 1, type: 'query', path, input, context: {}, signal: null as never },
      next: wrappedNext,
    } as never).subscribe({
      next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
      error: (err: unknown) => reject(err as Error),
      complete: () => {
        /* resolved via next */
      },
    })
  })

  return { promise, ...state }
}

describe('ipcParentLink', () => {
  it('routes via callOut when getCallOut returns a function', async () => {
    const receivedInputs: CapCallInput[] = []
    const callOut = async (input: CapCallInput): Promise<unknown> => {
      receivedInputs.push(input)
      return { ok: 1 }
    }
    const getCallOut = () => callOut

    const { promise, nextCalled } = runOp(getCallOut, 'motionZones.getStatus', { deviceId: 15 })
    const data = await promise

    expect(data).toEqual({ ok: 1 })
    expect(nextCalled).toBe(false)
    expect(receivedInputs).toHaveLength(1)
    expect(receivedInputs[0]).toEqual({
      capName: 'motion-zones',
      method: 'getStatus',
      args: { deviceId: 15 },
      deviceId: 15,
    })
  })

  it('delegates to next (broker) when getCallOut returns null (not connected)', async () => {
    const getCallOut = (): null => null

    const nextFn = vi.fn(() =>
      observable((observer) => {
        observer.next({ result: { type: 'data', data: 'FROM_BROKER' } })
        observer.complete()
        return () => {}
      }),
    )

    const link = ipcParentLink(getCallOut)({} as never)
    const data = await new Promise<unknown>((resolve, reject) => {
      link({
        op: {
          id: 1,
          type: 'query',
          path: 'motionZones.getStatus',
          input: { deviceId: 15 },
          context: {},
          signal: null as never,
        },
        next: nextFn,
      } as never).subscribe({
        next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
        error: (err: unknown) => reject(err as Error),
        complete: () => {},
      })
    })

    expect(data).toBe('FROM_BROKER')
    expect(nextFn).toHaveBeenCalledOnce()
  })

  it('falls back to broker (next) when callOut rejects with a no-route error', async () => {
    const callOut = async (): Promise<unknown> => {
      throw new Error(
        `${UDS_NO_ROUTE_PREFIX}: cap-call-out has no local provider for "motion-zones" and no fallback`,
      )
    }
    const getCallOut = () => callOut

    const nextFn = vi.fn(() =>
      observable((observer) => {
        observer.next({ result: { type: 'data', data: 'BROKER_ROUTED' } })
        observer.complete()
        return () => {}
      }),
    )

    const link = ipcParentLink(getCallOut)({} as never)
    const data = await new Promise<unknown>((resolve, reject) => {
      link({
        op: {
          id: 1,
          type: 'query',
          path: 'motionZones.getStatus',
          input: { deviceId: 15 },
          context: {},
          signal: null as never,
        },
        next: nextFn,
      } as never).subscribe({
        next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
        error: (err: unknown) => reject(err as Error),
        complete: () => {},
      })
    })

    expect(data).toBe('BROKER_ROUTED')
    expect(nextFn).toHaveBeenCalledOnce()
  })

  it('propagates real provider errors (does NOT fall back to broker)', async () => {
    const callOut = async (): Promise<unknown> => {
      throw new Error('camera offline')
    }
    const getCallOut = () => callOut

    const nextFn = vi.fn(() =>
      observable((observer) => {
        observer.next({ result: { type: 'data', data: 'SHOULD_NOT_REACH' } })
        observer.complete()
        return () => {}
      }),
    )

    const link = ipcParentLink(getCallOut)({} as never)
    await expect(
      new Promise<unknown>((resolve, reject) => {
        link({
          op: {
            id: 1,
            type: 'query',
            path: 'motionZones.getStatus',
            input: { deviceId: 15 },
            context: {},
            signal: null as never,
          },
          next: nextFn,
        } as never).subscribe({
          next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
          error: (err: unknown) => reject(err as Error),
          complete: () => {},
        })
      }),
    ).rejects.toThrow('camera offline')

    expect(nextFn).not.toHaveBeenCalled()
  })

  it('reads a node pin already on op.context onto CapCallInput.nodeId', async () => {
    const receivedInputs: CapCallInput[] = []
    const getCallOut = () => async (input: CapCallInput) => {
      receivedInputs.push(input)
      return { ok: 1 }
    }
    const link = ipcParentLink(getCallOut)({} as never)
    await new Promise<unknown>((resolve, reject) => {
      link({
        op: {
          id: 1,
          type: 'query',
          path: 'platformProbe.getCapabilities',
          input: undefined,
          context: { __camstackNodePin: 'agent-a' },
          signal: null as never,
        },
        next: () => observable(() => () => {}),
      } as never).subscribe({
        next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
        error: (err: unknown) => reject(err as Error),
        complete: () => {},
      })
    })
    expect(receivedInputs[0]?.nodeId).toBe('agent-a')
    expect(receivedInputs[0]?.capName).toBe('platform-probe')
  })

  it('lifts a per-call node pin through the REAL tRPC client (nodePin → op.context → CapCallInput.nodeId)', async () => {
    // Proves the end-to-end out-of-band channel: `nodePin(nodeId)` passed as the
    // second arg of `.query()` reaches the link as `op.context`, and ipcParentLink
    // lifts it onto `CapCallInput.nodeId`. This is the assumption the whole
    // per-node routing rests on — verified against the actual @trpc/client, not a
    // hand-built op object.
    const receivedInputs: CapCallInput[] = []
    const getCallOut = () => async (input: CapCallInput) => {
      receivedInputs.push(input)
      return { hardware: { npu: null, gpu: null } }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped dynamic tRPC proxy for the test
    const client: any = createTRPCClient({ links: [ipcParentLink(getCallOut)] })
    await client.platformProbe.getCapabilities.query(undefined, nodePin('agent-a'))
    expect(receivedInputs).toHaveLength(1)
    expect(receivedInputs[0]?.capName).toBe('platform-probe')
    expect(receivedInputs[0]?.method).toBe('getCapabilities')
    expect(receivedInputs[0]?.nodeId).toBe('agent-a')
  })

  it('omits nodeId when no pin is present (default resolution unchanged)', async () => {
    const receivedInputs: CapCallInput[] = []
    const getCallOut = () => async (input: CapCallInput) => {
      receivedInputs.push(input)
      return { ok: 1 }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped dynamic tRPC proxy for the test
    const client: any = createTRPCClient({ links: [ipcParentLink(getCallOut)] })
    await client.platformProbe.getCapabilities.query()
    expect(receivedInputs[0]?.nodeId).toBeUndefined()
  })

  it('delegates to next (broker) when path is unparseable', async () => {
    const callOut = vi.fn(async (): Promise<unknown> => ({ ok: 1 }))
    const getCallOut = () => callOut

    const nextFn = vi.fn(() =>
      observable((observer) => {
        observer.next({ result: { type: 'data', data: 'DELEGATED_UNPARSEABLE' } })
        observer.complete()
        return () => {}
      }),
    )

    const link = ipcParentLink(getCallOut)({} as never)
    const data = await new Promise<unknown>((resolve, reject) => {
      link({
        // No dot in path → parsePath returns null
        op: {
          id: 1,
          type: 'query',
          path: 'no-dot-here',
          input: {},
          context: {},
          signal: null as never,
        },
        next: nextFn,
      } as never).subscribe({
        next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
        error: (err: unknown) => reject(err as Error),
        complete: () => {},
      })
    })

    expect(data).toBe('DELEGATED_UNPARSEABLE')
    expect(nextFn).toHaveBeenCalledOnce()
    expect(callOut).not.toHaveBeenCalled()
  })
})
