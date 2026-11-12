/**
 * #522 — a battery-low episode whose device no longer HAS the `battery` cap is
 * closed (the Enpal storage battery, device 5693, lost the cap and kept an open
 * "Battery è al 19%" episode with nothing left to ever close it).
 *
 * The gate is D49: the cap census is read off the event path, a failed read
 * changes nothing, and closing — destructive — needs a SECOND consecutive read
 * that agrees. Each read must come from a provider that is UP: a device with
 * no native binding at all (its runner crashed or is restarting) is no answer,
 * and its episode is kept. The close is silent (nothing recovered) and logged
 * with `tags.deviceId`.
 *
 * The census is the production `batteryCapCensusOver`, fed the `getBindings`
 * entries a real answer carries.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcAlertRow } from '../alert-episode.js'
import {
  batteryCapCensusOver,
  type NcBindingEntryFacts,
  type NcDeviceBindingsFacts,
} from '../battery-cap-census.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'

const STORAGE = 5693
const NOW = Date.UTC(2026, 10, 12, 20, 0)

/** What the bindings read answers for the storage battery on one tick. */
type Answer = 'battery' | 'no-battery' | 'no-bindings' | 'fails'

const NATIVE_BASE: readonly NcBindingEntryFacts[] = [
  { capName: 'device-status', kind: 'native' },
  { capName: 'numeric-sensor', kind: 'native' },
]

function bindingsFor(answer: Answer): NcDeviceBindingsFacts {
  switch (answer) {
    case 'battery':
      return { entries: [...NATIVE_BASE, { capName: 'battery', kind: 'native' }] }
    case 'no-battery':
      return { entries: NATIVE_BASE }
    case 'no-bindings':
      // The owning runner is down: only a wrapper another addon holds is left.
      return { entries: [{ capName: 'detection-pipeline', kind: 'wrapped' }] }
    case 'fails':
      throw new Error('getBindings timed out')
  }
}

interface LogLine {
  readonly level: 'info' | 'debug'
  readonly message: string
  readonly deviceId: number | undefined
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly rows: Map<string, NcAlertRow>
  readonly lines: LogLine[]
  readonly emitted: string[]
  answer: Answer
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const base = makeSilentLogger()
  return {
    ...base,
    info: (message, extras) => {
      lines.push({ level: 'info', message, deviceId: extras?.tags?.deviceId })
    },
    debug: (message, extras) => {
      lines.push({ level: 'debug', message, deviceId: extras?.tags?.deviceId })
    },
    child: () => capturingLogger(lines),
    withTags: () => capturingLogger(lines),
  }
}

function openRow(subject: string): NcAlertRow {
  return {
    subject,
    alerting: true,
    since: NOW - 86_400_000,
    lastNotifiedAt: NOW - 86_400_000,
    reminders: 0,
  }
}

function harness(options: { readonly wired: boolean }): Harness {
  const subject = `battery:${STORAGE}`
  const rows = new Map<string, NcAlertRow>([[subject, openRow(subject)]])
  const lines: LogLine[] = []
  const emitted: string[] = []
  const census = batteryCapCensusOver(async (deviceId) =>
    deviceId === STORAGE ? bindingsFor(h.answer) : bindingsFor('battery'),
  )
  const h: Harness = {
    rows,
    lines,
    emitted,
    answer: 'battery',
    alerts: new NcDeviceAlerts({
      emit: async (event) => {
        emitted.push(event.subject.systemEvent?.kind ?? 'unknown')
        return true
      },
      settings: (): NcDeviceAlertSettings => ({
        batteryLowPercent: 20,
        renotifyMinutes: 0,
        notifyRecovery: true,
      }),
      consumableThresholds: () => [],
      lookup: (id) =>
        id === STORAGE
          ? { deviceId: STORAGE, type: 'sensor', name: 'Battery', isCamera: false, online: true }
          : undefined,
      rulesVersion: () => 'v1',
      rows: {
        get: (key) => rows.get(key),
        put: (next) => {
          rows.set(next.subject, next)
        },
        all: () => [...rows.values()],
        remove: async (key) => {
          rows.delete(key)
        },
      },
      now: () => NOW,
      logger: capturingLogger(lines),
      ...(options.wired ? { batteryCapCensus: census } : {}),
    }),
  }
  return h
}

async function reconcile(h: Harness, ...answers: Answer[]): Promise<void> {
  for (const answer of answers) {
    h.answer = answer
    await h.alerts.reconcileBatteryCaps()
  }
}

const OPEN = `battery:${STORAGE}`

describe('#522 — a battery episode whose device lost the battery cap', () => {
  it('is closed on the SECOND consecutive read that finds no cap — silently, logged per device', async () => {
    const h = harness({ wired: true })
    await reconcile(h, 'no-battery')
    expect(h.rows.has(OPEN)).toBe(true)
    await reconcile(h, 'no-battery')
    expect(h.rows.has(OPEN)).toBe(false)
    expect(h.emitted).toEqual([])
    const close = h.lines.find((line) => line.message.includes('no longer has the battery cap'))
    expect(close?.level).toBe('info')
    expect(close?.deviceId).toBe(STORAGE)
  })

  it('a read that finds the cap again resets the count', async () => {
    const h = harness({ wired: true })
    await reconcile(h, 'no-battery', 'battery', 'no-battery')
    expect(h.rows.has(OPEN)).toBe(true)
  })

  it('a failed read changes nothing — it neither closes nor resets', async () => {
    const h = harness({ wired: true })
    await reconcile(h, 'no-battery', 'fails')
    expect(h.rows.has(OPEN)).toBe(true)
    await reconcile(h, 'no-battery')
    expect(h.rows.has(OPEN)).toBe(false)
  })

  it('a device with NO native binding (its provider is down) keeps the episode, and says so', async () => {
    const h = harness({ wired: true })
    await reconcile(h, 'no-bindings', 'no-bindings', 'no-bindings')
    expect(h.rows.has(OPEN)).toBe(true)
    const skip = h.lines.find((line) => line.message.includes('holds no native binding'))
    expect(skip?.deviceId).toBe(STORAGE)
    // An outage between two "no cap" reads does not count as either.
    await reconcile(h, 'no-battery', 'no-bindings')
    expect(h.rows.has(OPEN)).toBe(true)
  })

  it('an unwired read never reads as agreement', async () => {
    const h = harness({ wired: false })
    await reconcile(h, 'no-battery', 'no-battery')
    expect(h.rows.has(OPEN)).toBe(true)
  })
})
