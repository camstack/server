import { describe, expect, it } from 'vitest'
import type { DeviceTransition, TransitionActor } from '@camstack/types'
import {
  actionNamesFromList,
  actuationActorLabel,
  actuationFieldLabel,
  actuationOutcomeTone,
  actuationRelativeTime,
  actuationRow,
  actuationClock,
  actuationExactTime,
  actuationSection,
  mergeActuationPages,
  type ActuationNameBook,
  type ActuationPhrases,
} from '../actuation-model'

const NOW = Date.UTC(2026, 9, 9, 9, 31)

const PHRASES: ActuationPhrases = {
  justNow: 'just now',
  minutesAgo: (n) => `${n} min ago`,
  hoursAgo: (n) => `${n} h ago`,
  daysAgo: (n) => `${n} d ago`,
  on: 'On',
  off: 'Off',
  unknown: '—',
  device: 'The device',
  user: 'User',
  automation: 'Automation',
  addon: 'Add-on',
  scheduler: 'Schedule',
  composition: 'Composition',
  node: 'This node',
  confirmed: 'Confirmed',
  deviceOutcome: 'By the device',
  already: 'Already set',
  unconfirmed: 'Unconfirmed',
  failed: 'Failed',
}

const NO_NAMES: ActuationNameBook = {
  actionName: () => undefined,
  automationName: () => undefined,
}

const user: TransitionActor = {
  kind: 'user',
  userId: 'u1',
  username: 'Ada',
  credential: 'session',
}

interface RowPatch extends Partial<DeviceTransition> {
  readonly id: string
  readonly at: number
}

function row(patch: RowPatch): DeviceTransition {
  return {
    deviceId: 201,
    capName: 'climate-control',
    field: 'target',
    from: 28,
    to: 22,
    outcome: 'confirmed',
    actor: user,
    ...patch,
  }
}

describe('actuation field labels and values', () => {
  it('uses the cap vocabulary for the field and the value, and the field name when none exists', () => {
    const target = actuationRow(row({ id: 'a', at: NOW - 3_600_000 }), NOW, 'en', PHRASES, NO_NAMES)
    expect(target.field).toBe('Set temperature')
    expect(target.change).toBe('28°C → 22°C')

    const mode = actuationRow(
      row({
        id: 'b',
        at: NOW,
        field: 'mode',
        from: 'auto',
        to: 'heat',
      }),
      NOW,
      'it',
      PHRASES,
      NO_NAMES,
    )
    expect(mode.field).toBe('Modalità')
    expect(mode.change).toBe('Automatico → Riscaldamento')

    const bare = actuationRow(
      row({
        id: 'c',
        at: NOW,
        capName: 'not-a-cap',
        field: 'customFlag',
        from: 'x',
        to: 'y',
      }),
      NOW,
      'en',
      PHRASES,
      NO_NAMES,
    )
    expect(bare.field).toBe('customFlag')
    expect(bare.change).toBe('x → y')
  })

  it('formats a boolean like the card (on/off) and an unknown side as not reported', () => {
    const power = actuationRow(
      row({
        id: 'p',
        at: NOW,
        capName: 'switch',
        field: 'on',
        from: true,
        to: false,
      }),
      NOW,
      'en',
      PHRASES,
      NO_NAMES,
    )
    expect(actuationFieldLabel('switch', 'on', 'en')).toBe('On')
    expect(power.change).toBe('On → Off')

    const unknown = actuationRow(
      row({ id: 'u', at: NOW, from: null, to: 22 }),
      NOW,
      'en',
      PHRASES,
      NO_NAMES,
    )
    expect(unknown.change).toBe('— → 22°C')
  })
})

describe('actuation actors and outcomes', () => {
  it('names a user, an automation when the name is known, and the device itself', () => {
    expect(actuationActorLabel(user, NO_NAMES, PHRASES)).toBe('Ada')
    const named: ActuationNameBook = {
      actionName: (id) => (id === 'act-night' ? 'Good night' : undefined),
      automationName: () => undefined,
    }
    expect(
      actuationActorLabel(
        {
          kind: 'action',
          addonId: 'core-blocks',
          actionId: 'act-night',
          runId: 'run-1',
          automationId: 'auto-1',
        },
        named,
        PHRASES,
      ),
    ).toBe('Good night')
    expect(
      actuationActorLabel(
        {
          kind: 'action',
          addonId: 'core-blocks',
          actionId: 'act-x',
          runId: 'run-2',
        },
        NO_NAMES,
        PHRASES,
      ),
    ).toBe('Automation')
    expect(actuationActorLabel({ kind: 'device' }, NO_NAMES, PHRASES)).toBe('The device')
  })

  it('keeps failed and unconfirmed distinct and mutes already', () => {
    expect(actuationOutcomeTone('failed')).toBe('danger')
    expect(actuationOutcomeTone('unconfirmed')).toBe('warning')
    expect(actuationOutcomeTone('already')).toBe('neutral')
    expect(actuationOutcomeTone('confirmed')).toBe('success')
    expect(actuationOutcomeTone('device')).toBe('default')
  })

  it('says how long ago, and keeps the absolute instant for the hover', () => {
    expect(actuationRelativeTime(NOW - 30_000, NOW, PHRASES)).toBe('just now')
    expect(actuationRelativeTime(NOW - 5 * 60_000, NOW, PHRASES)).toBe('5 min ago')
    expect(actuationRelativeTime(NOW - 2 * 3_600_000, NOW, PHRASES)).toBe('2 h ago')
    expect(actuationRelativeTime(NOW - 3 * 86_400_000, NOW, PHRASES)).toBe('3 d ago')
    const view = actuationRow(row({ id: 't', at: NOW - 5 * 60_000 }), NOW, 'en', PHRASES, NO_NAMES)
    expect(view.relative).toBe('5 min ago')
    expect(view.absolute).toBe(new Date(NOW - 5 * 60_000).toLocaleString('en'))
  })
})

describe('actuation list state', () => {
  it('hides when the capability is absent, and never calls an unanswered read empty', () => {
    expect(actuationSection('absent', { status: 'ok', count: 0, nextCursor: null }).kind).toBe(
      'hidden',
    )
    expect(actuationSection('pending', null).kind).toBe('skeleton')
    expect(actuationSection('unknown', null).kind).toBe('unread')
    expect(actuationSection('present', { status: 'pending' }).kind).toBe('skeleton')
    expect(actuationSection('present', { status: 'error' }).kind).toBe('unread')
    expect(actuationSection('present', { status: 'ok', count: 0, nextCursor: null }).kind).toBe(
      'empty',
    )
    const list = actuationSection('present', {
      status: 'ok',
      count: 2,
      nextCursor: 'c2',
    })
    expect(list).toEqual({ kind: 'list', nextCursor: 'c2' })
  })

  it('pages newest first without mutating the pages it was given', () => {
    const older = row({ id: 'old', at: 1 })
    const newer = row({ id: 'new', at: 2 })
    const page = [older]
    const merged = mergeActuationPages([page, [newer, older]])
    expect(merged.map((r) => r.id)).toEqual(['new', 'old'])
    expect(page).toEqual([older])
  })

  it('reads action names only from entries that actually have them', () => {
    expect(actionNamesFromList(undefined).size).toBe(0)
    expect(
      actionNamesFromList([
        { id: 'a', name: 'Night' },
        { id: 1, name: 'no' },
      ]).get('a'),
    ).toBe('Night')
  })
})

describe('actuation clock and details', () => {
  const at = new Date(2026, 9, 9, 8, 5, 3, 42).getTime()
  const noon = new Date(2026, 9, 9, 12, 0, 0, 0).getTime()

  it('shows HH:MM:SS today and prefixes the day on another day', () => {
    expect(actuationClock(at, noon, 'en')).toBe('08:05:03')
    expect(actuationClock(at, noon + 86_400_000, 'en')).toBe('10/09 08:05:03')
  })

  it('keeps the milliseconds in the exact time', () => {
    expect(actuationExactTime(at, 'en').endsWith('08:05:03.042')).toBe(true)
  })

  it('carries capability, who, command and the row id into the details', () => {
    const view = actuationRow(
      row({
        id: '201:1:0',
        at,
        command: {
          commandId: 'c1',
          method: 'setTarget',
          args: { value: 22 },
          requestedAt: at,
          matchedAfterMs: 120,
        },
      }),
      noon,
      'en',
      PHRASES,
      NO_NAMES,
    )
    expect(view.clock).toBe('08:05:03')
    expect(view.details).toMatchObject({
      capability: 'climate-control',
      actorKind: 'User',
      actorName: 'Ada',
      command: 'setTarget({"value":22})',
      outcome: 'Confirmed',
      rowId: '201:1:0',
    })
  })
})
