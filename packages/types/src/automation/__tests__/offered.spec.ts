import { describe, expect, it } from 'vitest'
import { VocabActionError } from '../../device/cap-vocabulary/action-index.js'
import { assertStepsOffered } from '../offered.js'
import type { AutomationAction } from '../recipe.js'

/** Which devices are bound to which cap, as the directory's per-binding walk answers. */
function directory(bound: Readonly<Record<string, readonly number[]>>) {
  const asked: string[] = []
  return {
    asked,
    listDeviceIdsByCaps: async (caps: readonly string[]) => {
      asked.push(...caps)
      return caps.flatMap((cap) => bound[cap] ?? [])
    },
  }
}

const open = (ids: number[]): AutomationAction => ({
  kind: 'command',
  target: { kind: 'devices', ids },
  actionId: 'cover.open',
})

describe('assertStepsOffered — the save-boundary check of a command step', () => {
  it('passes when every named device is bound to the cap of the action', async () => {
    await expect(
      assertStepsOffered([open([1, 2])], directory({ cover: [1, 2, 3] })),
    ).resolves.toBeUndefined()
  })

  it('refuses a device that does not offer the action, naming the action and the device', async () => {
    const err = await assertStepsOffered([open([1, 9])], directory({ cover: [1] })).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(VocabActionError)
    expect(err).toMatchObject({ reason: 'not-offered', actionId: 'cover.open', deviceId: 9 })
  })

  it('reads the else branch too', async () => {
    const step: AutomationAction = {
      kind: 'command',
      target: { kind: 'devices', ids: [1] },
      actionId: 'cover.open',
      else: [{ kind: 'command', target: { kind: 'devices', ids: [7] }, actionId: 'cover.open' }],
    }
    await expect(assertStepsOffered([step], directory({ cover: [1] }))).rejects.toMatchObject({
      deviceId: 7,
    })
  })

  it('does not check a domain target, which is resolved when the step runs', async () => {
    const dir = directory({})
    const step: AutomationAction = {
      kind: 'command',
      target: { kind: 'domain', roomId: 'Kitchen' },
      actionId: 'cover.open',
    }
    await expect(assertStepsOffered([step], dir)).resolves.toBeUndefined()
    expect(dir.asked).toEqual([])
  })

  it('asks the directory once per cap', async () => {
    const dir = directory({ cover: [1, 2] })
    await assertStepsOffered([open([1]), open([2])], dir)
    expect(dir.asked).toEqual(['cover'])
  })
})
