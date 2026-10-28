import { describe, expect, it } from 'vitest'
import { EspIrOverrides, loadIrOverrides } from '../esphome-ir-overrides.js'
import { captureLogger, type LogLine } from './fake-ctx.js'

describe('loadIrOverrides', () => {
  it('reads irServices of every listed device from its store', async () => {
    const overrides = new EspIrOverrides()
    const lines: LogLine[] = []
    await loadIrOverrides({
      deviceIds: [1, 2, 3],
      overrides,
      logger: captureLogger(lines),
      readStores: async (ids) =>
        new Map(
          ids.map((id): [number, Record<string, unknown>] => [
            id,
            id === 1 ? { irServices: ['send_rf:rf'] } : id === 2 ? { irServices: [] } : {},
          ]),
        ),
    })
    expect(overrides.get(1)).toEqual([{ name: 'send_rf', media: ['rf'] }])
    expect(overrides.get(2)).toEqual([])
    expect(overrides.get(3)).toBe('auto')
  })

  it('warns with the device id on a malformed value and falls back to automatic', async () => {
    const overrides = new EspIrOverrides()
    overrides.set(5, [{ name: 'old', media: ['ir'] }])
    const lines: LogLine[] = []
    await loadIrOverrides({
      deviceIds: [5],
      overrides,
      logger: captureLogger(lines),
      readStores: async () => new Map([[5, { irServices: 42 }]]),
    })
    expect(overrides.get(5)).toBe('auto')
    expect(lines.find((l) => l.level === 'warn')?.extras).toMatchObject({ tags: { deviceId: 5 } })
  })
})
