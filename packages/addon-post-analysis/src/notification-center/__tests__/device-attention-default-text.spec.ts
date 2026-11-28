/**
 * The DEFAULT text of `device-attention-required` / `-resolved` names every
 * active fault, code and label — not only the principal's label — in both
 * languages, and the resolve edge names the fault that cleared.
 */
import {
  alertEpisodePayload,
  DeviceType,
  EventCategory,
  type Alert,
  type DeviceFault,
  type SystemEvent,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NcTextCatalog, type NcLanguage } from '../text-catalog.js'

const NOW = Date.UTC(2026, 10, 21, 8, 0)

const CLIMA: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Sensor,
  name: 'Clima cameretta 2',
  isCamera: false,
})

const UNREACH: DeviceFault = { code: 'UNREACH', label: 'Device unreachable', severity: 'error' }
const LOWBAT: DeviceFault = { code: 'LOWBAT', label: 'Battery low', severity: 'warning' }
const STICKY: DeviceFault = { code: 'STICKY_UNREACH', label: 'Radio flaky', severity: 'warning' }

function alertOf(faults: readonly DeviceFault[], status: Alert['status'] = 'active'): Alert {
  const [principal] = faults
  return {
    id: 'device-error:7',
    category: 'device.error',
    severity: 'critical',
    title: `Clima cameretta 2: ${principal?.label ?? 'Fault'}`,
    message: `Clima cameretta 2 reports a fault: ${principal?.label ?? 'Fault'}.`,
    status,
    read: false,
    createdAt: NOW,
    updatedAt: NOW,
    source: { type: 'device', id: '7' },
    metadata: { episodeId: 'device-error:7@1', faults },
  }
}

function eventOf(alert: Alert, phase: 'raised' | 'resolved'): SystemEvent {
  return {
    id: 'ev-1',
    timestamp: new Date(NOW),
    source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
    category: EventCategory.AlertEpisode,
    data: { ...alertEpisodePayload(alert, phase, NOW) },
  }
}

function render(
  faults: readonly DeviceFault[],
  phase: 'raised' | 'resolved',
  language: NcLanguage,
): { title: string; body: string } {
  const alert = alertOf(faults, phase === 'raised' ? 'active' : 'completed')
  const sys = incomingFromSystemEvent(eventOf(alert, phase), CLIMA)?.subject.systemEvent
  if (sys?.titleKey === undefined || sys.bodyKey === undefined) throw new Error('no system event')
  const texts = new NcTextCatalog({ language })
  return {
    title: texts.text({ key: sys.titleKey, vars: sys.textParams }),
    body: texts.text({ key: sys.bodyKey, vars: sys.textParams }),
  }
}

describe('device-attention default text names the fault', () => {
  it('one fault: code and label in title and body (en)', () => {
    const r = render([UNREACH], 'raised', 'en')
    expect(r.title).toBe('Clima cameretta 2 — Device unreachable (UNREACH)')
    expect(r.body).toContain('Device unreachable (UNREACH)')
  })

  it('three faults: every code and label is listed', () => {
    const r = render([UNREACH, LOWBAT, STICKY], 'raised', 'en')
    for (const text of [r.title, r.body]) {
      expect(text).toContain('Device unreachable (UNREACH)')
      expect(text).toContain('Battery low (LOWBAT)')
      expect(text).toContain('Radio flaky (STICKY_UNREACH)')
    }
  })

  it('italian default carries the same facts', () => {
    const r = render([UNREACH, LOWBAT], 'raised', 'it')
    expect(r.title).toBe('Clima cameretta 2 — Device unreachable (UNREACH), Battery low (LOWBAT)')
    expect(r.body).toContain('UNREACH')
  })

  it('resolved names the fault that cleared (en + it)', () => {
    const en = render([UNREACH], 'resolved', 'en')
    expect(en.title).toBe('Resolved: Clima cameretta 2 — Device unreachable (UNREACH)')
    expect(en.body).toContain('Device unreachable (UNREACH)')
    const it = render([UNREACH], 'resolved', 'it')
    expect(it.title).toBe('Risolto: Clima cameretta 2 — Device unreachable (UNREACH)')
    expect(it.body).toContain('UNREACH')
  })

  it('an alert with no faults keeps the alert title and message', () => {
    const alert = { ...alertOf([]), title: 'PIN required', message: 'Needs its PIN' }
    const sys = incomingFromSystemEvent(eventOf(alert, 'raised'), CLIMA)?.subject.systemEvent
    expect(sys?.titleKey).toBe('system.device-attention-required.title')
  })
})
