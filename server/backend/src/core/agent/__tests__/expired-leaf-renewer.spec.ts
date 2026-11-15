/**
 * An agent admitted on an expired mesh leaf (#558) is renewed through the existing handover - but
 * only once it has registered (until then it has no capability to prepare a CSR), once at a time,
 * and a node that never registers is reported rather than retried.
 */
import type { RenewMeshResult } from '@camstack/server/system'
import { describe, expect, it, vi } from 'vitest'
import { createExpiredLeafRenewer } from '../expired-leaf-renewer'

interface Logged {
  readonly level: string
  readonly tags: Record<string, string> | undefined
}

const OK: RenewMeshResult = { ok: true, oldSerial: 'a', newSerial: 'b', newNotAfter: 1 }

function rig(result: RenewMeshResult | null = OK) {
  const logs: Logged[] = []
  const log = {
    info: (_m: string, extras?: { tags?: Record<string, string> }) =>
      void logs.push({ level: 'info', tags: extras?.tags }),
    warn: (_m: string, extras?: { tags?: Record<string, string> }) =>
      void logs.push({ level: 'warn', tags: extras?.tags }),
    error: (_m: string, extras?: { tags?: Record<string, string> }) =>
      void logs.push({ level: 'error', tags: extras?.tags }),
  }
  const listeners = new Set<(nodeId: string) => void>()
  const timers: (() => void)[] = []
  const renew = vi.fn(async (_nodeId: string) => result)
  const onExpired = createExpiredLeafRenewer({
    log,
    renew,
    registrations: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    setTimer: (fn) => {
      timers.push(fn)
      return { cancel: () => undefined }
    },
  })
  const registered = (nodeId: string): void => {
    for (const l of [...listeners]) l(nodeId)
  }
  return { onExpired, renew, registered, logs, timers, listeners }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const peer = (nodeId: string) => ({ nodeId, serial: '01', notAfter: 1 })
const warnedFor = (logs: readonly Logged[], nodeId: string): boolean =>
  logs.some((l) => l.level === 'warn' && l.tags?.['nodeId'] === nodeId)

describe('createExpiredLeafRenewer', () => {
  it('renews only after the node registers, and only that node', async () => {
    const r = rig()
    r.onExpired(peer('agent-old'))
    await flush()
    expect(r.renew).not.toHaveBeenCalled()

    r.registered('someone-else')
    await flush()
    expect(r.renew).not.toHaveBeenCalled()

    r.registered('agent-old')
    await flush()
    expect(r.renew).toHaveBeenCalledTimes(1)
    expect(r.renew).toHaveBeenCalledWith('agent-old')
    expect(r.listeners.size).toBe(0)
    expect(r.logs.some((l) => l.level === 'info' && l.tags?.['nodeId'] === 'agent-old')).toBe(true)
  })

  it('runs one renewal per node even when the handshake is announced twice', async () => {
    const r = rig()
    r.onExpired(peer('agent-old'))
    r.onExpired(peer('agent-old'))
    r.registered('agent-old')
    await flush()
    expect(r.renew).toHaveBeenCalledTimes(1)
  })

  it('reports a node that never registers and does not renew it', async () => {
    const r = rig()
    r.onExpired(peer('agent-old'))
    r.timers[0]?.()
    r.registered('agent-old')
    await flush()
    expect(r.renew).not.toHaveBeenCalled()
    expect(warnedFor(r.logs, 'agent-old')).toBe(true)
  })

  it('warns, tagged with the node, when the renewal fails or cannot start', async () => {
    const failed = rig({ ok: false, stage: 'prepare', reason: 'boom', keptPreviousLeaf: true })
    failed.onExpired(peer('agent-old'))
    failed.registered('agent-old')
    await flush()
    expect(warnedFor(failed.logs, 'agent-old')).toBe(true)

    const unavailable = rig(null)
    unavailable.onExpired(peer('agent-b'))
    unavailable.registered('agent-b')
    await flush()
    expect(warnedFor(unavailable.logs, 'agent-b')).toBe(true)
  })
})
