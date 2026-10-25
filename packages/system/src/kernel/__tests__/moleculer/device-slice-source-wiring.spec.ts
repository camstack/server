import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A forked addon child that watches device slices through `live.onEvent`
 * never declares UDS `eventPatterns`, so `device.state-changed` never
 * arrives (live, device 102, 2026-07-16). The DeviceProxy the runner
 * mints must use `createEventBusSliceSource` and pass it as `stateSource`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../moleculer')
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8')

describe('forked DeviceProxy slice source is the event bus, not live.onEvent', () => {
  it('addon-context-factory wires createEventBusSliceSource into every proxy', () => {
    const src = read('addon-context-factory.ts')
    expect(src).toContain('createEventBusSliceSource')
    expect(src).toContain('stateSource: deviceSliceSource')
    expect(src).not.toMatch(/createDeviceProxy\([^)]*createLazyTrpcSource/)
  })

  it('worker DeviceManagerApi uses the same source', () => {
    const src = read('device-cap-proxy.ts')
    expect(src).toContain('createEventBusSliceSource')
    expect(src).toContain('stateSource: deviceSliceSource')
  })
})
