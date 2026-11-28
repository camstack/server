import type { Alert, IScopedLogger } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import {
  addonsBelowMinimum,
  heldInstallAlertId,
  raiseHeldInstallAlerts,
  requiredAddonAlertId,
  runRequiredAddonUpdates,
} from '../required-addon-update.js'

function logger(): IScopedLogger {
  const sink: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => sink,
    withTags: () => sink,
  }
  return sink
}

const MINIMUMS = {
  '@dominevo/addon-old': '>=2.0.0',
  '@dominevo/addon-fine': '>=1.0.0',
  '@dominevo/addon-unreadable': '>=1.0.0',
  '@dominevo/addon-absent': '>=1.0.0',
}
const INSTALLED = {
  '@dominevo/addon-old': '1.5.0',
  '@dominevo/addon-fine': '1.0.0',
  '@dominevo/addon-unreadable': null,
}

describe('addonsBelowMinimum', () => {
  it('names the stale and the unreadable, never the current or the absent', () => {
    expect(addonsBelowMinimum(MINIMUMS, INSTALLED).map((b) => b.name)).toEqual([
      '@dominevo/addon-old',
      '@dominevo/addon-unreadable',
    ])
  })
})

describe('runRequiredAddonUpdates (planning#447)', () => {
  it('updates exactly the below-minimum set and raises an alert for a failure without stopping', async () => {
    const updatePackage = vi.fn(async (name: string) =>
      name === '@dominevo/addon-old' ? { success: false, error: 'npm 503' } : { success: true },
    )
    const emitted: Alert[] = []
    const updates: { alertId: string }[] = []
    const report = await runRequiredAddonUpdates({
      minimums: MINIMUMS,
      installed: () => INSTALLED,
      updatePackage,
      getAlerts: () => ({
        emit: async (a) => void emitted.push(a),
        update: async (u) => void updates.push({ alertId: u.alertId }),
      }),
      logger: logger(),
      now: () => 42,
    })
    expect(updatePackage.mock.calls.map((c) => c[0])).toEqual([
      '@dominevo/addon-old',
      '@dominevo/addon-unreadable',
    ])
    expect(report.updated).toEqual(['@dominevo/addon-unreadable'])
    expect(report.failed).toEqual([{ name: '@dominevo/addon-old', reason: 'npm 503' }])
    expect(emitted.map((a) => a.id)).toEqual([requiredAddonAlertId('@dominevo/addon-old')])
    expect(emitted[0]?.message).toContain('npm 503')
    expect(updates).toEqual([{ alertId: requiredAddonAlertId('@dominevo/addon-unreadable') }])
  })

  it('treats a throwing updater as a failure and keeps going', async () => {
    const updatePackage = vi.fn(async (name: string) => {
      if (name === '@dominevo/addon-old') throw new Error('boom')
      return { success: true }
    })
    const report = await runRequiredAddonUpdates({
      minimums: MINIMUMS,
      installed: () => INSTALLED,
      updatePackage,
      getAlerts: () => undefined,
      logger: logger(),
    })
    expect(report.failed.map((f) => f.reason)).toEqual(['boom'])
    expect(report.updated).toEqual(['@dominevo/addon-unreadable'])
  })
})

describe('raiseHeldInstallAlerts', () => {
  it('raises one critical alert per install the boot installer held back, naming the reason', async () => {
    const emit = vi.fn(async (_alert: Alert) => undefined)
    await raiseHeldInstallAlerts({
      held: [
        {
          packageName: '@dominevo/addon-x',
          spec: 'latest',
          code: 'no-compatible-version',
          reason: 'latest requires server >= 9.0.0, running 1.2.0, and no registry version fits',
        },
      ],
      getAlerts: () => ({ emit, update: async () => undefined }),
      logger: logger(),
      now: () => 5,
    })
    expect(emit).toHaveBeenCalledTimes(1)
    const alert = emit.mock.calls[0]?.[0]
    expect(alert?.id).toBe(heldInstallAlertId('@dominevo/addon-x'))
    expect(alert?.severity).toBe('critical')
    expect(alert?.message).toContain('9.0.0')
  })

  it('says so in the log when there is no alerts provider, and raises nothing', async () => {
    const sink = logger()
    await raiseHeldInstallAlerts({
      held: [
        {
          packageName: '@dominevo/addon-x',
          spec: 'latest',
          code: 'registry-unreadable',
          reason: 'r',
        },
      ],
      getAlerts: () => undefined,
      logger: sink,
    })
    expect(sink.warn).toHaveBeenCalled()
  })

  it('resolves the alert of a package a later boot installed (held at boot N, installed at boot N+1)', async () => {
    const store = new Map<string, Alert>()
    const port = {
      emit: vi.fn(async (a: Alert) => void store.set(a.id, a)),
      update: vi.fn(async (i: { alertId: string; patch: Partial<Alert> }) => {
        const cur = store.get(i.alertId)
        if (cur !== undefined) store.set(i.alertId, { ...cur, ...i.patch })
      }),
      list: vi.fn(async () => [...store.values()]),
    }
    const base = { getAlerts: () => port, logger: logger() }
    await raiseHeldInstallAlerts({
      ...base,
      held: [
        {
          packageName: '@dominevo/addon-x',
          spec: 'latest',
          code: 'no-compatible-version',
          reason: 'r',
        },
      ],
    })
    expect(store.get(heldInstallAlertId('@dominevo/addon-x'))?.status).toBe('active')
    await raiseHeldInstallAlerts({ ...base, held: [] })
    expect(store.get(heldInstallAlertId('@dominevo/addon-x'))?.status).toBe('completed')
  })
})
