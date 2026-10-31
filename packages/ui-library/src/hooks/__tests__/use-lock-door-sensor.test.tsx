// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { CompositionSchema } from '@camstack/types'

let mockContact: { entryOpen?: boolean } | undefined

vi.mock('../use-device-proxy', () => ({
  useDeviceState: () => mockContact,
}))

import { useLockDoorSensor } from '../use-lock-door-sensor'

const LOCK = { addonId: 'ha', stableId: 'lock.front' }
const SENSOR = { addonId: 'ha', stableId: 'binary_sensor.front' }

const linked = {
  source: {
    kind: 'composition' as const,
    composition: CompositionSchema.parse({
      target: { kind: 'existing', device: LOCK },
      features: [
        {
          kind: 'fields',
          cap: 'lock-control',
          fields: {
            state: {
              kind: 'expression',
              expr: 'x',
              bindings: {
                x: { kind: 'from', source: SENSOR, cap: 'contact', fieldPath: 'entryOpen' },
              },
            },
          },
        },
      ],
    }),
  },
}

function fakeTrpc(view: { block: unknown } | null) {
  return {
    deviceManager: {
      getBindings: { query: vi.fn() },
      getDevice: { query: vi.fn(async () => ({ id: 7, ...LOCK })) },
      listAll: { query: vi.fn(async () => [{ id: 9, ...SENSOR, name: 'Front contact' }]) },
    },
    coreBlocks: {
      getCustomization: { query: vi.fn(async () => ({ state: 'loaded' as const, view })) },
    },
  }
}

describe('useLockDoorSensor', () => {
  it('reads the linked sensor name and its own state', async () => {
    mockContact = { entryOpen: true }
    const trpc = fakeTrpc({ block: linked })
    const { result } = renderHook(() => useLockDoorSensor(trpc as never, 7))
    await waitFor(() => expect(result.current).toEqual({ name: 'Front contact', reading: 'open' }))
  })

  it('is unknown until the sensor slice arrives', async () => {
    mockContact = undefined
    const trpc = fakeTrpc({ block: linked })
    const { result } = renderHook(() => useLockDoorSensor(trpc as never, 7))
    await waitFor(() => expect(result.current?.reading).toBe('unknown'))
  })

  it('is unknown for a slice with no reading, never closed', async () => {
    mockContact = {}
    const trpc = fakeTrpc({ block: linked })
    const { result } = renderHook(() => useLockDoorSensor(trpc as never, 7))
    await waitFor(() => expect(result.current?.reading).toBe('unknown'))
  })

  it('is null when the lock has no customization', async () => {
    mockContact = { entryOpen: false }
    const trpc = fakeTrpc(null)
    const { result } = renderHook(() => useLockDoorSensor(trpc as never, 7))
    await waitFor(() => expect(trpc.coreBlocks.getCustomization.query).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})
