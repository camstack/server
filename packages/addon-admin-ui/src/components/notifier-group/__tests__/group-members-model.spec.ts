import type { GroupMember, Target } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  isPickableTarget,
  pickCandidates,
  previewOf,
  readMembers,
  withMembers,
  withoutKey,
  kindLabelOf,
  classesText,
  eventKindsOff,
  fallbackChoices,
  withClassesText,
  withEventKinds,
  withFallbackFor,
  withoutMember,
} from '../group-members-model'

const target = (id: string, kind: string, name = id): Target => ({
  id,
  name,
  kind,
  addonId: 'a',
  enabled: true,
  config: {},
})

describe('group member model', () => {
  it('never offers a group, nor a target already in the group', () => {
    const targets = [target('g', 'group'), target('n', 'ntfy', 'Phone'), target('t', 'telegram')]
    const members: GroupMember[] = [{ targetId: 't' }]
    expect(pickCandidates(targets, members, '').map((x) => x.id)).toEqual(['n'])
    expect(isPickableTarget(target('g', 'group'))).toBe(false)
  })

  it('filters by name or kind, case-insensitively', () => {
    const targets = [target('n', 'ntfy', 'Phone'), target('t', 'telegram', 'Ops')]
    expect(pickCandidates(targets, [], 'PHO').map((x) => x.id)).toEqual(['n'])
    expect(pickCandidates(targets, [], 'tele').map((x) => x.id)).toEqual(['t'])
  })

  it('counts a row the schema cannot read instead of showing it', () => {
    const read = readMembers({ members: [{ targetId: 'a' }, { nope: true }] })
    expect(read.members).toHaveLength(1)
    expect(read.invalid).toBe(1)
  })

  it('removes an optional key rather than writing undefined', () => {
    const member: GroupMember = {
      targetId: 'a',
      minPriority: 3,
      throttleSec: 5,
    }
    const next = withoutKey(member, 'minPriority')
    expect('minPriority' in next).toBe(false)
    expect(next.throttleSec).toBe(5)
    expect(withMembers({ name: 'x' }, [next])).toEqual({
      name: 'x',
      members: [next],
    })
  })

  it('previews the delivered text through the delivery shaper', () => {
    expect(previewOf({ targetId: 'a', fields: ['title'] })).toEqual({
      title: 'Person at the front door',
      body: '',
    })
    expect(previewOf({ targetId: 'a', templates: { title: 'Alert: {{title}}' } }).title).toBe(
      'Alert: Person at the front door',
    )
  })
})

describe('kindLabelOf', () => {
  const kinds = [
    { kind: 'alexa-echo', label: 'Alexa Echo', addonId: 'alexa' },
    { kind: 'alexa-echo', label: 'Other Echo', addonId: 'other' },
  ]
  it('names the kind by its catalogue label, matched on kind and providing addon', () => {
    expect(kindLabelOf(kinds, { kind: 'alexa-echo', addonId: 'other' })).toBe('Other Echo')
    expect(kindLabelOf(kinds, { kind: 'alexa-echo', addonId: 'alexa' })).toBe('Alexa Echo')
  })
  it('falls back to the kind id while the catalogue is unanswered or lacks the kind', () => {
    expect(kindLabelOf(undefined, { kind: 'alexa-echo', addonId: 'alexa' })).toBe('alexa-echo')
    expect(kindLabelOf(kinds, { kind: 'ntfy', addonId: 'alexa' })).toBe('ntfy')
  })
})

describe('member content filter and fallback model', () => {
  it('keeping every kind, or none, removes the kind filter instead of writing an empty list', () => {
    const filtered = withEventKinds({ targetId: 'a' }, ['detection', 'audio'])
    expect(filtered.filter).toEqual({ eventKinds: ['detection', 'audio'] })
    expect(eventKindsOff(filtered).has('system-event')).toBe(true)
    expect(eventKindsOff(filtered).has('detection')).toBe(false)
    expect('filter' in withEventKinds(filtered, [])).toBe(false)
  })

  it('reads typed classes, trims them, and keeps the kind filter beside them', () => {
    const member = withClassesText(
      withEventKinds({ targetId: 'a' }, ['detection']),
      ' person, car ,',
    )
    expect(member.filter).toEqual({ eventKinds: ['detection'], classes: ['person', 'car'] })
    expect(classesText(member)).toBe('person, car')
    expect(withClassesText(member, '').filter).toEqual({ eventKinds: ['detection'] })
  })

  it('offers only the members listed before as fallback primaries', () => {
    const members: GroupMember[] = [{ targetId: 'a' }, { targetId: 'b' }, { targetId: 'c' }]
    expect(fallbackChoices(members, 'a')).toEqual([])
    expect(fallbackChoices(members, 'c').map((m) => m.targetId)).toEqual(['a', 'b'])
    expect(withFallbackFor({ targetId: 'b' }, 'a').onlyIfUndelivered).toEqual(['a'])
    expect(
      'onlyIfUndelivered' in
        withFallbackFor({ targetId: 'b', onlyIfUndelivered: ['a'] }, undefined),
    ).toBe(false)
  })

  it('removing a member removes the fallback rules that named it', () => {
    const members: GroupMember[] = [{ targetId: 'a' }, { targetId: 'b', onlyIfUndelivered: ['a'] }]
    expect(withoutMember(members, 'a')).toEqual([{ targetId: 'b' }])
  })
})
