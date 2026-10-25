import { describe, expect, it } from 'vitest'
import { serverManagementCapability } from '../server-management.cap.js'

describe('server-management cap and the D877 pre-flight', () => {
  const apply = serverManagementCapability.methods.applyServerUpdate

  it('applyServerUpdate takes acknowledgeRefusals and stays admin-gated', () => {
    expect(apply.input.parse({ version: '1.2.600', acknowledgeRefusals: true })).toEqual({
      version: '1.2.600',
      acknowledgeRefusals: true,
    })
    expect(apply.auth).toBe('admin')
  })

  it('the result carries blockers', () => {
    expect(
      apply.output.parse({
        accepted: false,
        targetVersion: '1.2.600',
        restarting: false,
        message: 'Refused',
        outcome: 'refused',
        reason: 'addon-would-refuse',
        blockers: [{ addonId: 'auth', reason: 'r', remedy: 'm' }],
      }).blockers,
    ).toHaveLength(1)
  })
})
