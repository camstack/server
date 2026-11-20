import type { GroupMember, Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  isPickableTarget,
  pickCandidates,
  previewOf,
  readMembers,
  withMembers,
  withoutKey,
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
