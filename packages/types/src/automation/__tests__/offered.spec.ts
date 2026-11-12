import { describe, expect, it } from 'vitest'
import { VocabActionError } from '../../device/cap-vocabulary/action-index.js'
import { assertStepsOffered, type BoundCapsReader } from '../offered.js'
import type { AutomationAction } from '../recipe.js'

/** Each device's own binding map, as `getBindingsBatch` answers for the ids asked. */
function bindings(bound: Readonly<Record<number, readonly string[]>>) {
  const asked: (readonly number[])[] = []
  const reader: BoundCapsReader = {
    boundCapsOf: async (ids) => {
      asked.push(ids)
      return new Map(ids.map((id) => [id, bound[id] ?? []]))
    },
  }
  return { asked, reader }
}

const open = (ids: number[]): AutomationAction => ({
  kind: 'command',
  target: { kind: 'devices', ids },
  actionId: 'cover.open',
})

describe('assertStepsOffered — the save-boundary check of a command step', () => {
  it('passes when every named device is bound to the cap of the action', async () => {
    const { reader } = bindings({ 1: ['cover'], 2: ['cover', 'switch'] })
    await expect(assertStepsOffered([open([1, 2])], reader)).resolves.toBeUndefined()
  })

  it('refuses a device that does not offer the action, naming the action and the device', async () => {
    const { reader } = bindings({ 1: ['cover'], 9: ['switch'] })
    const err = await assertStepsOffered([open([1, 9])], reader).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VocabActionError)
    expect(err).toMatchObject({ reason: 'not-offered', actionId: 'cover.open', deviceId: 9 })
  })

  it('refuses an unknown action even when the target names no device yet', async () => {
    const { reader } = bindings({})
    const step: AutomationAction = {
      kind: 'command',
      target: { kind: 'devices', ids: [] },
      actionId: 'cover.renamed',
    }
    await expect(assertStepsOffered([step], reader)).rejects.toMatchObject({
      reason: 'unknown-action',
    })
  })

  it('reads the else branch of a top-level step', async () => {
    const step: AutomationAction = {
      kind: 'command',
      target: { kind: 'devices', ids: [1] },
      actionId: 'cover.open',
      else: [{ kind: 'command', target: { kind: 'devices', ids: [7] }, actionId: 'cover.open' }],
    }
    const { reader } = bindings({ 1: ['cover'] })
    await expect(assertStepsOffered([step], reader)).rejects.toMatchObject({ deviceId: 7 })
  })

  it('reads the else of a choose nested in a block body', async () => {
    const step: AutomationAction = {
      kind: 'repeat',
      loop: { by: 'count', count: 2 },
      steps: [
        {
          kind: 'choose',
          branches: [
            {
              if: { kind: 'triggered-by', leafIds: ['motion'] },
              steps: [
                { kind: 'command', target: { kind: 'devices', ids: [1] }, actionId: 'cover.open' },
              ],
            },
          ],
          else: [
            { kind: 'command', target: { kind: 'devices', ids: [8] }, actionId: 'cover.open' },
          ],
        },
      ],
    }
    const { reader } = bindings({ 1: ['cover'] })
    await expect(assertStepsOffered([step], reader)).rejects.toMatchObject({ deviceId: 8 })
  })

  it('reads a command two blocks down', async () => {
    const step: AutomationAction = {
      kind: 'repeat',
      loop: { by: 'count', count: 2 },
      steps: [
        {
          kind: 'choose',
          branches: [
            {
              if: { kind: 'triggered-by', leafIds: ['motion'] },
              steps: [
                { kind: 'command', target: { kind: 'devices', ids: [9] }, actionId: 'cover.open' },
              ],
            },
          ],
        },
      ],
    }
    const { reader } = bindings({})
    await expect(assertStepsOffered([step], reader)).rejects.toMatchObject({ deviceId: 9 })
  })

  it('does not check a domain target, which is resolved when the step runs', async () => {
    const { reader, asked } = bindings({})
    const step: AutomationAction = {
      kind: 'command',
      target: { kind: 'domain', roomId: 'Kitchen' },
      actionId: 'cover.open',
    }
    await expect(assertStepsOffered([step], reader)).resolves.toBeUndefined()
    expect(asked).toEqual([])
  })

  it('reads the named devices’ bindings once, in one batch', async () => {
    const { reader, asked } = bindings({ 1: ['cover'], 2: ['cover'] })
    await assertStepsOffered([open([1]), open([2, 1])], reader)
    expect(asked).toEqual([[1, 2]])
  })
})
