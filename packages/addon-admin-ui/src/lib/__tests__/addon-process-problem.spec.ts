import { describe, expect, it } from 'vitest'
import { addonProcessProblem } from '../addon-process-problem.js'

describe('addonProcessProblem (D877): the Addons page judges the truthful runner state', () => {
  it("a refused runner is an error and carries the addon's own reason", () => {
    expect(
      addonProcessProblem({ state: 'refused', reason: 'legacy blobs - run the migration' }),
    ).toEqual({
      kind: 'refused',
      reason: 'legacy blobs - run the migration',
    })
  })
  it.each(['failed', 'missing', 'crashed'])('%s is an error', (state) => {
    expect(addonProcessProblem({ state })?.kind).toBe(state)
  })
  it.each([
    'running',
    'starting',
    'unknown',
    'stopped',
  ])('%s is not an error (unknown is not broken)', (state) => {
    expect(addonProcessProblem({ state })).toBeNull()
  })
  it('no process at all is not an error', () => {
    expect(addonProcessProblem(undefined)).toBeNull()
  })
})
