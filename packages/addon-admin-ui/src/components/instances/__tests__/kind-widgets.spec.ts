import { describe, expect, it } from 'vitest'
import { kindWidget, withoutFields } from '../kind-widgets'

describe('withoutFields', () => {
  const schema = {
    sections: [
      { id: 'a', fields: [{ key: 'members' }] },
      { id: 'b', fields: [{ key: 'x' }, { key: 'members' }] },
    ],
  }

  it('drops a section the widget emptied and keeps the others', () => {
    const next = withoutFields(schema, ['members'])
    expect(next.sections.map((s) => s.id)).toEqual(['b'])
    expect(next.sections[0]?.fields).toEqual([{ key: 'x' }])
  })

  it('leaves the schema alone when the widget owns nothing', () => {
    expect(withoutFields(schema, [])).toBe(schema)
  })

  it('knows the group member editor', () => {
    expect(kindWidget('notifier/group-members')).not.toBeNull()
  })
})
