/**
 * The log lines a migration writes through the migration API: delivered in the order the steps
 * wrote them, and a refused delivery is neither an unhandled rejection nor a thrown step.
 */
import { describe, expect, it, vi } from 'vitest'
import { defaultIntegrationDepsOver, rowsDepsOver } from '../migration-api-ports.js'
import type { MigrationApiV1 } from '../migration-api.v1.js'

type LogInput = { readonly message: string }

function apiWithLog(logLine: (input: LogInput) => Promise<Record<string, never>>): MigrationApiV1 {
  const none = async (): Promise<never> => {
    throw new Error('not used here')
  }
  return {
    version: 1,
    ledger: { declare: none, start: none, finish: none },
    legacyRows: { read: none, clear: none, patch: none, deleteKeys: none },
    records: {
      kind: () => ({
        get: none,
        getResolved: none,
        put: none,
        putMany: none,
        patch: none,
        delete: none,
        query: none,
        deleteWhere: none,
      }),
    },
    settings: { read: none, write: none, deleteKeys: none },
    secrets: { resolve: none, put: none, delete: none },
    integrations: { list: none, get: none },
    devices: { list: none, get: none, setIntegrationId: none },
    node: { localNodeId: none },
    log: { info: logLine, warn: logLine },
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('migration API log ports', () => {
  it('delivers warn, info and warnDevice lines in the order they were written', async () => {
    const seen: string[] = []
    const slowFirst = async (input: LogInput) => {
      if (input.message === 'a') await tick()
      seen.push(input.message)
      return {}
    }
    const deps = defaultIntegrationDepsOver(apiWithLog(slowFirst))
    deps.warn('a')
    void deps.info('b')
    await deps.warnDevice('c', 7)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('does not leave an unhandled rejection when the log door refuses a line', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const messages: string[] = []
      const warn = async (input: LogInput) => {
        if (input.message === 'boom') throw new Error('door down')
        messages.push(input.message)
        return {}
      }
      const deps = rowsDepsOver(apiWithLog(warn))
      deps.warn('boom')
      deps.warn('after')
      await tick()
      await tick()
      expect(unhandled).not.toHaveBeenCalled()
      expect(messages.some((m) => m.includes('could not be delivered: door down'))).toBe(true)
      expect(messages).toContain('after')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
