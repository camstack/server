import { describe, expect, it } from 'vitest'
import { findViolations } from '../check-one-instance-create-door.js'

describe('check-one-instance-create-door', () => {
  it('refuses the retired door in product source', () => {
    const v = findViolations([
      { path: 'packages/x/src/a.ts', text: 'await api.integrations.create.mutate(input)' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0]?.where).toBe('packages/x/src/a.ts:1')
  })

  it('refuses the retired hook', () => {
    expect(
      findViolations([{ path: 'packages/x/src/a.tsx', text: 'useIntegrationsCreate({})' }]),
    ).toHaveLength(1)
  })

  it('lets a spec name it', () => {
    expect(
      findViolations([
        { path: 'packages/x/src/__tests__/a.spec.ts', text: 'integrations.create is gone' },
      ]),
    ).toEqual([])
  })

  it('refuses a create method on the integrations cap and a second createInstance', () => {
    expect(
      findViolations([
        {
          path: 'packages/types/src/capabilities/integrations.cap.ts',
          text: '    create: method(Input, Output, {})',
        },
        {
          path: 'packages/types/src/capabilities/other.cap.ts',
          text: '    createInstance: method(Input, Output, {})',
        },
      ]),
    ).toHaveLength(2)
  })

  it('lets integration-instances own createInstance', () => {
    expect(
      findViolations([
        {
          path: 'packages/types/src/capabilities/integration-instances.cap.ts',
          text: '    createInstance: method(Input, Output, {})',
        },
      ]),
    ).toEqual([])
  })
})
