import { describe, expect, it } from 'vitest'
import type { NcSystemEventKind } from '../../capabilities/notification-rules.cap.js'
import {
  expandSystemEventClasses,
  isSystemEventRecoveryKind,
  NC_SYSTEM_EVENT_CLASS_SPECS,
  systemEventClassesFor,
  systemEventClassKinds,
  withSystemEventClasses,
} from '../system-event-classes.js'
import { NC_SYSTEM_EVENT_FAMILY } from '../system-event-families.js'

const instant = (kinds: readonly NcSystemEventKind[]) => ({
  delivery: 'system-event',
  conditions: { systemEvent: { kinds: [...kinds] } },
})

describe('D906 — paired system events are one class', () => {
  it('every class lives in ONE family, and a kind is in at most one class', () => {
    const seen = new Set<string>()
    for (const spec of NC_SYSTEM_EVENT_CLASS_SPECS) {
      expect(spec.bad.length, spec.id).toBeGreaterThan(0)
      expect(spec.recovery.length, spec.id).toBeGreaterThan(0)
      for (const kind of systemEventClassKinds(spec)) {
        expect(NC_SYSTEM_EVENT_FAMILY[kind], `${spec.id}/${kind}`).toBe(spec.family)
        expect(seen.has(kind), kind).toBe(false)
        seen.add(kind)
      }
    }
  })

  it('a class expands to both edges', () => {
    expect(expandSystemEventClasses(['stream-offline'])).toEqual([
      'stream-offline',
      'stream-online',
    ])
    expect(expandSystemEventClasses(['recording-healthy'])).toEqual([
      'recording-healthy',
      'recording-stalled',
      'recording-degraded',
    ])
    expect(isSystemEventRecoveryKind('stream-online')).toBe(true)
    expect(isSystemEventRecoveryKind('stream-offline')).toBe(false)
  })

  it('a bad edge never brings a sibling bad edge, and one-edge kinds stay single', () => {
    expect(expandSystemEventClasses(['storage-location-critical'])).toEqual([
      'storage-location-critical',
      'storage-location-ok',
    ])
    expect(expandSystemEventClasses(['node-restarting', 'backup-completed'])).toEqual([
      'node-restarting',
      'backup-completed',
    ])
  })

  it('an INSTANT one-edge rule normalises to the class', () => {
    const rule = withSystemEventClasses(instant(['stream-offline']))
    expect(rule.conditions.systemEvent?.kinds).toEqual(['stream-offline', 'stream-online'])
  })

  it('a rule already carrying both edges is returned as it is', () => {
    const rule = instant(['stream-offline', 'stream-online'])
    expect(withSystemEventClasses(rule)).toBe(rule)
  })

  it('is idempotent: a widened stall rule does not grow the sibling bad edge on the next read', () => {
    const once = expandSystemEventClasses(['recording-stalled'])
    expect(once).toEqual(['recording-stalled', 'recording-healthy'])
    expect(expandSystemEventClasses(once)).toEqual(once)
  })

  it('a SCHEDULED summary rule is never widened — it reports the bad state, not edges', () => {
    const summary = {
      ...instant(['device-offline']),
      systemEventDelivery: {
        mode: 'summary' as const,
        schedule: { timezone: 'UTC', windows: [{ days: [1], startMinute: 1200, endMinute: 1260 }] },
      },
    }
    expect(withSystemEventClasses(summary)).toBe(summary)
  })

  it('a mixed rule stays as it is (read-only, D637)', () => {
    const mixed = instant(['stream-offline', 'node-offline'])
    expect(withSystemEventClasses(mixed)).toBe(mixed)
  })

  it('each family offers its own classes', () => {
    expect(systemEventClassesFor('device-events').map((c) => c.id)).toContain('stream-connectivity')
    expect(systemEventClassesFor('system').map((c) => c.id)).toContain('rule-health')
    expect(systemEventClassesFor('alarm')).toEqual([])
  })
})
