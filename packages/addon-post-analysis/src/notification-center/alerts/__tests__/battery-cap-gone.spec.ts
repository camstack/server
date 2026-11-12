/**
 * #522 — a battery-low episode whose device no longer HAS the `battery` cap is
 * closed (the Enpal storage battery, device 5693, lost the cap and kept an open
 * "Battery è al 19%" episode with nothing left to ever close it).
 *
 * The gate is D49: the cap census is read off the event path, a failed read
 * changes nothing, and closing — destructive — needs a SECOND consecutive read
 * that agrees. A device the directory does not see online is not judged: a
 * provider that is restarting holds no bindings for a moment, and closing then
 * would re-raise the episode the moment the cap came back. The close is silent
 * (nothing recovered) and logged with `tags.deviceId`.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcDeviceIdentity } from '../../device-directory.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'

const STORAGE = 5693
const NOW = Date.UTC(2026, 10, 12, 20, 0)

interface InfoLine {
  readonly message: string
  readonly deviceId: number | undefined
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly rows: Map<string, NcAlertRow>
  readonly infos: InfoLine[]
  readonly emitted: string[]
  /** What the cap read answers for the storage battery (one value per reconcile). */
  readonly answers: (boolean | null)[]
  online: boolean
}

function capturingLogger(infos: InfoLine[]): IScopedLogger {
  const base = makeSilentLogger()
  return {
    ...base,
    info: (message, extras) => {
      infos.push({ message, deviceId: extras?.tags?.deviceId })
    },
    child: () => capturingLogger(infos),
    withTags: () => capturingLogger(infos),
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
  const rows = new Map<string, NcAlertRow>([[`battery:${STORAGE}`, openRow(`battery:${STORAGE}`)]])
  const infos: InfoLine[] = []
  const emitted: string[] = []
  const answers: (boolean | null)[] = []
  const identity = (): NcDeviceIdentity => ({
    deviceId: STORAGE,
    type: 'sensor',
    name: 'Battery',
    isCamera: false,
    online: h.online,
  })
  const h: Harness = {
    rows,
    infos,
    emitted,
    answers,
    online: true,
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
      lookup: (id) => (id === STORAGE ? identity() : undefined),
      rulesVersion: () => 'v1',
      rows: {
        get: (subject) => rows.get(subject),
        put: (next) => {
          rows.set(next.subject, next)
        },
        all: () => [...rows.values()],
        remove: async (subject) => {
          rows.delete(subject)
        },
      },
      now: () => NOW,
      logger: capturingLogger(infos),
      ...(options.wired
        ? {
            hasBatteryCap: async (deviceId: number): Promise<boolean | null> => {
              if (deviceId !== STORAGE) return true
              const [next] = answers
              return next === undefined ? true : next
            },
          }
        : {}),
    }),
  }
  return h
}

async function reconcile(h: Harness, ...answers: (boolean | null)[]): Promise<void> {
  for (const answer of answers) {
    h.answers.splice(0, h.answers.length, answer)
    await h.alerts.reconcileBatteryCaps()
  }
}

describe('#522 — a battery episode whose device lost the battery cap', () => {
  it('is closed on the SECOND consecutive read that finds no cap — silently, logged per device', async () => {
    const h = harness({ wired: true })
    await reconcile(h, false)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(true)
    await reconcile(h, false)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(false)
    expect(h.emitted).toEqual([])
    const close = h.infos.find((line) => line.message.includes('no longer has the battery cap'))
    expect(close?.deviceId).toBe(STORAGE)
  })

  it('a read that finds the cap again resets the count', async () => {
    const h = harness({ wired: true })
    await reconcile(h, false, true, false)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(true)
  })

  it('a failed read changes nothing — it neither closes nor resets', async () => {
    const h = harness({ wired: true })
    await reconcile(h, false, null)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(true)
    await reconcile(h, false)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(false)
  })

  it('a device that is not online is not judged: a restarting provider holds no bindings', async () => {
    const h = harness({ wired: true })
    h.online = false
    await reconcile(h, false, false, false)
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(true)
  })

  it('an unwired read never reads as agreement', async () => {
    const h = harness({ wired: false })
    await h.alerts.reconcileBatteryCaps()
    await h.alerts.reconcileBatteryCaps()
    expect(h.rows.has(`battery:${STORAGE}`)).toBe(true)
  })
})
