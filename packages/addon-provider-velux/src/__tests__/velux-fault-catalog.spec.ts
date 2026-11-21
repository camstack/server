/**
 * The catalog the gateway declares (`error.listFaultTypes`) lists every code the
 * fault reading can write: both derive from the same constants, and the spec
 * drives the reading through every state it has, so a code added to the writer
 * without a catalog entry fails here.
 */
import { describe, expect, it } from 'vitest'
import {
  VELUX_FAULT_AUTH_FAILED,
  VELUX_FAULT_CONNECTION_LOST,
  VELUX_FAULT_UNREACHABLE,
  VELUX_GATEWAY_FAULT_TYPES,
  VELUX_UNREACHABLE_FAULT_MS,
  veluxGatewayFaultReading,
  type VeluxFaultSource,
} from '../velux-gateway-faults.js'

const NOW = 10_000_000

const STATES: readonly VeluxFaultSource[] = [
  { status: 'error', attempted: true, loginRefused: true, unreachableSince: null, lastError: 'x' },
  {
    status: 'error',
    attempted: true,
    loginRefused: false,
    unreachableSince: NOW - VELUX_UNREACHABLE_FAULT_MS,
    lastError: 'x',
  },
  {
    status: 'error',
    attempted: true,
    loginRefused: false,
    unreachableSince: NOW - 1000,
    lastError: 'x',
  },
  {
    status: 'connected',
    attempted: true,
    loginRefused: false,
    unreachableSince: null,
    lastError: null,
  },
  {
    status: 'connecting',
    attempted: true,
    loginRefused: false,
    unreachableSince: null,
    lastError: null,
  },
  {
    status: 'disconnected',
    attempted: false,
    loginRefused: false,
    unreachableSince: null,
    lastError: null,
  },
]

describe('the Velux gateway fault catalog', () => {
  const declared = VELUX_GATEWAY_FAULT_TYPES.map((f) => f.code)

  it('lists every code constant the writer uses, once each', () => {
    expect([...declared].sort()).toEqual(
      [VELUX_FAULT_UNREACHABLE, VELUX_FAULT_AUTH_FAILED, VELUX_FAULT_CONNECTION_LOST].sort(),
    )
  })

  it('declares every code the reading writes, with the catalog entry words', () => {
    const written = STATES.map((s) => veluxGatewayFaultReading(s, NOW)).filter((r) => r.active)
    expect(new Set(written.map((r) => r.code))).toEqual(new Set(declared))
    for (const reading of written) {
      const entry = VELUX_GATEWAY_FAULT_TYPES.find((f) => f.code === reading.code)
      expect(entry).toMatchObject({ label: reading.label, severity: reading.severity })
      expect(reading.faults).toEqual([entry])
    }
  })
})
