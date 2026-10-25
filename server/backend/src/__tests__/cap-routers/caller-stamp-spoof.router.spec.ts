/**
 * A session cannot supply the caller stamp (D881).
 *
 * `keychain`, `device-history` and `records` trust `callerAddonId` in their
 * input to decide WHOSE data a call touches. The generated mount parses with
 * `.loose()`, so an admin session could add the key itself and act as another
 * addon. The mount strips it for these caps: the provider sees no caller.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

const SPOOF = 'victim-addon'

async function seenByProvider(capName: string, method: string, input: Record<string, unknown>) {
  const spy = vi.fn(async (_input: unknown) => null)
  const provider = new Proxy({}, { get: () => spy })
  const router = buildCapRouterForTest(capName, () => provider)
  await invokeProcedure(router, method, makeCtx('admin'), { ...input, callerAddonId: SPOOF })
  return spy.mock.calls[0]?.[0]
}

describe('caller stamp cannot be supplied over the mount', () => {
  it('records: a spoofed callerAddonId never reaches the provider', async () => {
    const seen = await seenByProvider('records', 'get', { kind: 'target', id: 'a' })
    expect(seen).toEqual({ kind: 'target', id: 'a' })
  })

  it('keychain: a spoofed callerAddonId never reaches the provider', async () => {
    const seen = await seenByProvider('keychain', 'resolve', {
      refs: ['secret://victim-addon/global/x'],
    })
    expect(JSON.stringify(seen)).not.toContain(SPOOF + '"')
    expect(seen).not.toHaveProperty('callerAddonId')
  })

  it("integrations: a spoofed callerAddonId never reaches getSettings (it would unlock the owner's resolved secrets)", async () => {
    const seen = await seenByProvider('integrations', 'getSettings', { id: 'int_0001' })
    expect(seen).toEqual({ id: 'int_0001' })
  })

  it('device-manager: a spoofed callerAddonId never reaches persistConfig / loadConfig', async () => {
    const seen = await seenByProvider('device-manager', 'loadConfig', { deviceId: 1 })
    expect(seen).toEqual({ deviceId: 1 })
  })

  it('device-history: a spoofed callerAddonId never reaches the provider', async () => {
    const seen = await seenByProvider('device-history', 'declareSeries', {
      name: 'x',
      subjectKind: 'device',
      kind: 'gauge',
      displayName: 'X',
      ingest: 'points',
    })
    expect(seen).not.toHaveProperty('callerAddonId')
  })
})
