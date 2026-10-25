/**
 * Unit tests for the cap-route-error-formatter.
 *
 * `formatTrpcError` is a pure function — no tRPC plumbing required.
 * We hand-craft minimal TRPCError-like / DefaultErrorShape-like objects
 * to verify the augmentation logic.
 */
import { describe, it, expect } from 'vitest'
import { TRPCError } from '@trpc/server'
import { CapRouteError } from '@camstack/system'
import { formatTrpcError } from '../../api/trpc/cap-route-error-formatter.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal DefaultErrorShape stub. */
function makeShape(
  overrides: Partial<{ message: string }> = {},
): Parameters<typeof formatTrpcError>[0]['shape'] {
  return {
    message: overrides.message ?? 'Something went wrong',
    code: -32603, // INTERNAL_SERVER_ERROR code number
    data: {
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
    },
  }
}

/** Build a TRPCError-like object that formatTrpcError accepts. */
function makeTrpcError(
  message: string,
  cause?: Error,
): Parameters<typeof formatTrpcError>[0]['error'] {
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message,
    cause,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('formatTrpcError', () => {
  it('returns shape unchanged when error is not a CapRouteError', () => {
    const shape = makeShape({ message: 'Boom' })
    const error = makeTrpcError('Some generic error')
    const result = formatTrpcError({ error, shape })
    expect(result).toStrictEqual(shape)
    expect(result.data).not.toHaveProperty('capRouteReason')
  })

  it('augments shape with capRouteReason when error.cause is a CapRouteError', () => {
    const capRouteErr = new CapRouteError('my-cap', undefined, {
      reason: 'no-provider',
      rejected: [{ kind: 'hub-in-process', why: 'no provider bound' }],
    })
    const shape = makeShape()
    const error = makeTrpcError('Capability "my-cap" provider not available', capRouteErr)
    const result = formatTrpcError({ error, shape })

    expect(result.data.capRouteReason).toBe('no-provider')
    expect(result.data.capRouteRejected).toStrictEqual([
      { kind: 'hub-in-process', why: 'no provider bound' },
    ])
    expect(result.data.capRouteNodeId).toBeUndefined()
    // Original shape fields preserved
    expect(result.message).toBe(shape.message)
    expect(result.code).toBe(shape.code)
  })

  it('augments shape with capRouteReason when error itself is a CapRouteError', () => {
    const capRouteErr = new CapRouteError('some-cap', undefined, {
      reason: 'node-offline',
      nodeId: 'node-abc',
      rejected: [{ kind: 'remote-moleculer', why: 'node node-abc is offline' }],
    })
    const shape = makeShape()
    // Wrap as TRPCError with the CapRouteError AS the cause
    const error = makeTrpcError('Transport failed', capRouteErr)
    const result = formatTrpcError({ error, shape })

    expect(result.data.capRouteReason).toBe('node-offline')
    expect(result.data.capRouteNodeId).toBe('node-abc')
    expect(result.data.capRouteRejected).toHaveLength(1)
  })

  it('surfaces transport-failed reason correctly (not absent provider)', () => {
    const capRouteErr = new CapRouteError('stream-params', 'getStatus', {
      reason: 'transport-failed',
      rejected: [{ kind: 'hub-local-uds', why: 'socket closed' }],
    })
    const shape = makeShape()
    const error = makeTrpcError('Transport failed', capRouteErr)
    const result = formatTrpcError({ error, shape })

    expect(result.data.capRouteReason).toBe('transport-failed')
    expect(result.data.capRouteRejected).toStrictEqual([
      { kind: 'hub-local-uds', why: 'socket closed' },
    ])
  })

  it('walks a nested cause chain to find a CapRouteError', () => {
    const capRouteErr = new CapRouteError('ptz', undefined, {
      reason: 'cap-unknown',
      rejected: [],
    })
    // Wrap two levels deep
    const innerError = new Error('dispatch failed', { cause: capRouteErr })
    const shape = makeShape()
    const error = makeTrpcError('Outer error', innerError)
    const result = formatTrpcError({ error, shape })

    expect(result.data.capRouteReason).toBe('cap-unknown')
  })

  it('returns shape unchanged for a plain Error (non-CapRouteError cause)', () => {
    const plainErr = new Error('plain cause')
    const shape = makeShape()
    const error = makeTrpcError('Wrapper', plainErr)
    const result = formatTrpcError({ error, shape })

    expect(result.data).not.toHaveProperty('capRouteReason')
    expect(result).toStrictEqual(shape)
  })
})
