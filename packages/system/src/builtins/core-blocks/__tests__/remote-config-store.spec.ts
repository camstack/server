import { EMPTY_REMOTE_CONFIG, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { remoteConfigStoreOver } from '../remote-wiring.js'

const TV = 12

interface WarnLine {
  readonly message: string
  readonly deviceId: number | undefined
}

function loggerOver(lines: WarnLine[]): IScopedLogger {
  const record = (
    message: string,
    context?: { readonly tags?: { readonly deviceId?: number } },
  ) => {
    lines.push({ message, deviceId: context?.tags?.deviceId })
  }
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: record,
    error: () => undefined,
    child: () => loggerOver(lines),
    withTags: () => loggerOver(lines),
  }
}

const binding = {
  action: { kind: 'cap' as const, deviceId: 3, cap: 'ir-transmitter', method: 'send' },
}
const good = { kind: 'sequence' as const, id: 'hdmi1', name: 'HDMI 1', steps: ['ok'] }
const badIr = {
  kind: 'ir' as const,
  id: 'hdmi2',
  name: 'HDMI 2',
  transmitterId: 3,
  payload: { kind: 'raw' as const, timings: [9000, 4500] },
}

function storeHolding(remote: unknown, writes: Record<string, unknown>[], lines: WarnLine[]) {
  return remoteConfigStoreOver(
    {
      readDeviceStore: async () => ({ remote }),
      writeDeviceStore: async (_deviceId, patch) => {
        writes.push(patch)
      },
    },
    loggerOver(lines),
  )
}

describe('remoteConfigStoreOver with a bad stored source', () => {
  it('reads the other sources and bindings, names the refusal and warns with the deviceId', async () => {
    const lines: WarnLine[] = []
    const store = storeHolding(
      { ...EMPTY_REMOTE_CONFIG, bindings: { ok: binding }, sources: [good, badIr] },
      [],
      lines,
    )
    const config = await store.read(TV)
    expect(config.sources).toEqual([good])
    expect(Object.keys(config.bindings)).toEqual(['ok'])
    expect(config.refusedSources?.[0]).toMatchObject({ id: 'hdmi2' })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.deviceId).toBe(TV)
  })

  it('never writes the read-time report back', async () => {
    const writes: Record<string, unknown>[] = []
    const store = storeHolding(undefined, writes, [])
    await store.write(TV, {
      ...EMPTY_REMOTE_CONFIG,
      refusedSources: [{ index: 0, id: 'x', name: 'X', reason: 'r' }],
    })
    expect(writes[0]).toEqual({ remote: EMPTY_REMOTE_CONFIG })
  })
})
