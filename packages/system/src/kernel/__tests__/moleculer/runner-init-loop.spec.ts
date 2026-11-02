import { AddonMigrationsBlockedError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { allBlockedRefusal, runAddonInits } from '../../moleculer/runner-init-loop.js'

interface Entry {
  readonly spec: { readonly addonId: string }
}
const entry = (addonId: string): Entry => ({ spec: { addonId } })

function ports() {
  const initialised: string[] = []
  const blockedLog: { addonId: string; ids: readonly string[] }[] = []
  const fatal: string[] = []
  return {
    initialised,
    blockedLog,
    fatal,
    port: {
      blocked: (addonId: string, ids: readonly string[]) => blockedLog.push({ addonId, ids }),
      fatal: (e: Entry, err: unknown): never => {
        fatal.push(`${e.spec.addonId}:${err instanceof Error ? err.message : 'x'}`)
        throw new Error('exit')
      },
    },
  }
}

describe('a runner whose member addon is blocked by its migrations', () => {
  it('keeps the other member running and reports the blocked one with its migration ids', async () => {
    const p = ports()
    const result = await runAddonInits([entry('a'), entry('b')], {
      ...p.port,
      init: async (e) => {
        if (e.spec.addonId === 'a') throw new AddonMigrationsBlockedError(['a/m1', 'a/m2'])
        p.initialised.push(e.spec.addonId)
      },
    })
    expect(p.initialised).toEqual(['b'])
    expect(result.initialised).toBe(1)
    expect(p.blockedLog).toEqual([{ addonId: 'a', ids: ['a/m1', 'a/m2'] }])
    expect(p.fatal).toEqual([])
  })

  it('recognises the error through a wrapper, by name (a bundled copy is not instanceof)', async () => {
    const p = ports()
    const foreign = Object.assign(new Error('x'), {
      name: 'AddonMigrationsBlockedError',
      migrationIds: ['z/1'],
    })
    await runAddonInits([entry('z')], {
      ...p.port,
      init: async () => {
        throw new Error('init failed', { cause: foreign })
      },
    })
    expect(p.blockedLog).toEqual([{ addonId: 'z', ids: ['z/1'] }])
  })

  it('still treats any other failure as fatal', async () => {
    const p = ports()
    await expect(
      runAddonInits([entry('a'), entry('b')], {
        ...p.port,
        init: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('exit')
    expect(p.fatal).toEqual(['a:boom'])
  })

  it('every member blocked: the run says so, and the refusal names the addons and ids', async () => {
    const p = ports()
    const result = await runAddonInits([entry('a')], {
      ...p.port,
      init: async () => {
        throw new AddonMigrationsBlockedError(['a/m1'])
      },
    })
    expect(result.initialised).toBe(0)
    const refusal = allBlockedRefusal(result.blocked)
    expect(refusal?.code).toBe('migrations-blocked')
    expect(refusal?.addonId).toBe('a')
    expect(refusal?.reason).toContain('a/m1')
    expect(allBlockedRefusal([])).toBeNull()
  })
})
