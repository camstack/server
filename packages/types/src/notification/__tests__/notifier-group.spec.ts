import { describe, expect, it } from 'vitest'
import type { TargetKindCaps } from '../../capabilities/notification-output.cap.js'
import type { Notification } from '../../interfaces/notification.js'
import {
  decideMember,
  groupMembersOf,
  renderMemberTemplate,
  shapeForMember,
  unionTargetKindCaps,
} from '../notifier-group.js'

const BASE: Notification = {
  title: 'Door',
  body: 'Front door opened',
  format: 'text',
  priority: 3,
  attachments: [{ mediaType: 'image', url: '/a.jpg' }],
  actions: [{ id: 'ack', label: 'Ack' }],
  metadata: { camera: 'Porch' },
}

function caps(over: Partial<TargetKindCaps>): TargetKindCaps {
  return {
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 0,
    levels: [],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 100,
    ...over,
  }
}

describe('groupMembersOf', () => {
  it('reads valid rows and names the invalid ones', () => {
    const read = groupMembersOf({
      members: [{ targetId: 'a', minPriority: 2 }, { targetId: '' }, 'junk'],
    })
    expect(read.members).toEqual([{ targetId: 'a', minPriority: 2 }])
    expect(read.invalid).toBe(2)
  })
  it('an absent members key is an empty group', () => {
    expect(groupMembersOf({})).toEqual({ members: [], invalid: 0 })
  })
})

describe('decideMember', () => {
  const at = Date.UTC(2026, 10, 20, 12, 0)
  it('sends a plain member', () => {
    expect(
      decideMember({
        member: { targetId: 'a' },
        notification: BASE,
        nowMs: at,
      }),
    ).toEqual({
      send: true,
    })
  })
  it('skips a disabled member', () => {
    expect(
      decideMember({
        member: { targetId: 'a', enabled: false },
        notification: BASE,
        nowMs: at,
      }),
    ).toEqual({ send: false, reason: 'member-disabled' })
  })
  it('skips below minPriority', () => {
    expect(
      decideMember({
        member: { targetId: 'a', minPriority: 4 },
        notification: BASE,
        nowMs: at,
      }),
    ).toEqual({ send: false, reason: 'below-min-priority' })
  })
  it('skips outside the schedule', () => {
    const member = {
      targetId: 'a',
      when: {
        kind: 'schedule' as const,
        schedule: {
          timezone: 'UTC',
          windows: [{ days: [0], startMinute: 0, endMinute: 60 }],
        },
      },
    }
    expect(decideMember({ member, notification: BASE, nowMs: at })).toEqual({
      send: false,
      reason: 'schedule-inactive',
    })
  })
  it('alarm gate: state in the set sends, outside skips, unreadable skips with its own reason', () => {
    const member = {
      targetId: 'a',
      when: {
        kind: 'alarm' as const,
        deviceId: 7,
        states: ['armed_away' as const],
      },
    }
    expect(
      decideMember({
        member,
        notification: BASE,
        nowMs: at,
        alarmState: 'armed_away',
      }),
    ).toEqual({
      send: true,
    })
    expect(
      decideMember({
        member,
        notification: BASE,
        nowMs: at,
        alarmState: 'disarmed',
      }),
    ).toEqual({
      send: false,
      reason: 'alarm-state',
    })
    expect(decideMember({ member, notification: BASE, nowMs: at, alarmState: null })).toEqual({
      send: false,
      reason: 'alarm-unreadable',
    })
  })
})

describe('shapeForMember', () => {
  it('title-only member (Alexa) gets no body, attachments or actions', () => {
    const shaped = shapeForMember({ targetId: 'a', fields: ['title'] }, BASE)
    expect(shaped.title).toBe('Door')
    expect(shaped.body).toBe('')
    expect(shaped.attachments).toBeUndefined()
    expect(shaped.actions).toBeUndefined()
  })
  it('absent fields keep everything; templates rewrite title and body', () => {
    const shaped = shapeForMember(
      {
        targetId: 'a',
        templates: { body: '{{camera}}: {{body}} (p{{priority}})' },
      },
      BASE,
    )
    expect(shaped.body).toBe('Porch: Front door opened (p3)')
    expect(shaped.attachments).toHaveLength(1)
  })
  it('renderMemberTemplate leaves an unknown variable empty', () => {
    expect(renderMemberTemplate('x{{nope}}y', BASE)).toBe('xy')
  })
})

describe('unionTargetKindCaps', () => {
  it('is the union of what the members deliver', () => {
    const union = unionTargetKindCaps([
      caps({ text: { title: true, body: false }, sound: true }),
      caps({
        attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
        actions: 3,
        bodyMaxLen: 500,
      }),
    ])
    expect(union.text).toEqual({ title: true, body: true })
    expect(union.attachments.mediaTypes).toEqual(['image'])
    expect(union.actions).toBe(3)
    expect(union.sound).toBe(true)
    expect(union.bodyMaxLen).toBe(500)
  })
  it('an empty list delivers title and body only', () => {
    const union = unionTargetKindCaps([])
    expect(union.text).toEqual({ title: true, body: true })
    expect(union.actions).toBe(0)
  })
})
