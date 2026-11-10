/**
 * #483 — a notifier declares which message fields it delivers, and ONE function
 * reads that declaration for the dispatcher, the admin editor and the viewer.
 */
import { describe, expect, it } from 'vitest'
import {
  NotificationSchema,
  type TargetKindCaps,
} from '../../capabilities/notification-output.cap.js'
import { prepareNotification } from '../degrade-engine.js'
import {
  deliverableFields,
  fieldSupportForTargets,
  sanitizeTargetOverride,
} from '../notification-fields.js'

function push(): TargetKindCaps {
  return {
    attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
    actions: 3,
    levels: [
      { id: 'low', label: 'Low', ordinal: 1 },
      { id: 'high', label: 'High', ordinal: 5 },
    ],
    format: ['text'],
    clickUrl: true,
    sound: true,
    ttl: false,
    bodyMaxLen: 4000,
  }
}

/** A speaker: a title, nothing else it shows. */
function speaker(): TargetKindCaps {
  return {
    text: { title: true, body: false },
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 0,
    levels: [{ id: 'default', label: 'Announce', ordinal: 3 }],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 250,
  }
}

describe('deliverableFields', () => {
  it('reads a kind declared before #483 (no `text`) as delivering title and body', () => {
    expect(deliverableFields(push())).toEqual([
      'title',
      'body',
      'attachments',
      'actions',
      'priority',
      'sound',
      'clickUrl',
    ])
  })

  it('a speaker that declares title-only delivers the title and nothing else', () => {
    expect(deliverableFields(speaker())).toEqual(['title'])
  })

  it('one level, or levels sharing one ordinal, is no priority to choose', () => {
    const caps = push()
    expect(
      deliverableFields({
        ...caps,
        levels: [
          { id: 'a', label: 'A', ordinal: 3 },
          { id: 'b', label: 'B', ordinal: 3 },
        ],
      }),
    ).not.toContain('priority')
  })
})

describe('fieldSupportForTargets', () => {
  it('all targets title-only → only the title is shown', () => {
    const support = fieldSupportForTargets([
      { name: 'Kitchen', fields: ['title'] },
      { name: 'Hall', fields: ['title'] },
    ])
    expect(support.filter((s) => s.shown).map((s) => s.field)).toEqual(['title'])
  })

  it('mixed targets → the union, and each field names the targets that drop it', () => {
    const support = fieldSupportForTargets([
      { name: 'Phone', fields: deliverableFields(push()) },
      { name: 'Kitchen', fields: ['title'] },
    ])
    const body = support.find((s) => s.field === 'body')
    expect(body).toEqual({ field: 'body', shown: true, droppedBy: ['Kitchen'] })
    expect(support.find((s) => s.field === 'title')?.droppedBy).toEqual([])
  })

  it('an unknown kind (catalog not answered) never hides a field', () => {
    const support = fieldSupportForTargets([
      { name: 'Kitchen', fields: ['title'] },
      { name: 'Unknown', fields: undefined },
    ])
    expect(support.every((s) => s.shown)).toBe(true)
  })

  it('no selection shows every field', () => {
    expect(fieldSupportForTargets([]).every((s) => s.shown)).toBe(true)
  })
})

describe('sanitizeTargetOverride — an unsupported override cannot be stored', () => {
  it('drops a body override for a title-only target and keeps the title', () => {
    expect(
      sanitizeTargetOverride({ template: { title: 'Gate', body: 'Someone is here' } }, ['title']),
    ).toEqual({ template: { title: 'Gate' } })
  })

  it('drops a priority override for a kind without a priority to choose', () => {
    expect(sanitizeTargetOverride({ priority: 5 }, ['title'])).toBeUndefined()
  })

  it('keeps the schedule whatever the kind delivers', () => {
    const schedule = { windows: [{ days: [1], startMinute: 0, endMinute: 60 }] }
    expect(sanitizeTargetOverride({ schedule }, ['title'])).toEqual({ schedule })
  })

  it('an unknown kind keeps everything', () => {
    expect(sanitizeTargetOverride({ template: { body: 'x' }, priority: 2 }, undefined)).toEqual({
      template: { body: 'x' },
      priority: 2,
    })
  })
})

describe('prepareNotification honours caps.text', () => {
  it('a title-only kind gets an empty body and says it dropped one', () => {
    const prepared = prepareNotification(
      speaker(),
      NotificationSchema.parse({ title: 'Person at the gate', body: 'seen at 12:00' }),
    )
    expect(prepared.title).toBe('Person at the gate')
    expect(prepared.body).toBe('')
    expect(prepared.renderedAs.dropped).toContain('body')
  })

  it('a kind without `text` keeps both, unchanged', () => {
    const prepared = prepareNotification(
      push(),
      NotificationSchema.parse({ title: 'T', body: 'B' }),
    )
    expect(prepared.title).toBe('T')
    expect(prepared.body).toBe('B')
  })
})
