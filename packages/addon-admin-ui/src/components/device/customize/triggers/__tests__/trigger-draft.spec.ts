import { linkedTriggerValues, type TemplateInstance } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  draftOps,
  EMPTY_DRAFT,
  withAdded,
  withEnabled,
  withParams,
  withRemoval,
  workingInstances,
} from '../trigger-draft'

const PARAMS = {
  targetDeviceId: 1,
  action: 'toggle' as const,
  capability: 'switch',
  sources: [{ kind: 'device-fired' as const, deviceId: 12 }],
}
const STORED: TemplateInstance = {
  blockId: 'a',
  name: 'A',
  enabled: true,
  templateId: 'builtin:linked-trigger',
  values: linkedTriggerValues(PARAMS),
  updatedAt: 0,
}

describe('trigger draft', () => {
  it('an empty draft writes nothing and shows the stored instances', () => {
    expect(draftOps([STORED], EMPTY_DRAFT)).toEqual([])
    expect(workingInstances([STORED], EMPTY_DRAFT)).toEqual([STORED])
  })

  it('an edit and an enable toggle are two writes, both against the stored block', () => {
    const edited = withParams(EMPTY_DRAFT, STORED, { ...PARAMS, action: 'off' })
    const working = workingInstances([STORED], edited)[0] ?? STORED
    const d = withEnabled(edited, working, false)
    expect(draftOps([STORED], d).map((o) => o.kind)).toEqual(['update', 'enable'])
  })

  it('a removal that empties the automation deletes it; an added one just disappears', () => {
    const del = withRemoval(EMPTY_DRAFT, STORED, { kind: 'delete' })
    expect(draftOps([STORED], del)).toEqual([{ kind: 'delete', blockId: 'a' }])
    expect(workingInstances([STORED], del)).toEqual([])
    const added = withAdded(EMPTY_DRAFT, { ...STORED, name: 'N' })
    const created = workingInstances([], added)[0] ?? STORED
    expect(draftOps([], added).map((o) => o.kind)).toEqual(['create'])
    expect(draftOps([], withRemoval(added, created, { kind: 'delete' }))).toEqual([])
  })
})
