/**
 * D444 — validation runs in the process that OWNS the schemas.
 *
 * The hub registers a forked catalog from the register-frame descriptor with
 * passthrough schemas (MsgPack cannot carry a Zod schema), so the only real
 * parse of a forked action's input and output is the runner's. Disarm: delete
 * the `safeParse` in the `custom` case of `child-addon-call-dispatch.ts` — the
 * first test passes a string where a number is declared and the handler
 * receives it unchallenged.
 */
import { customAction } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CustomActionRegistry } from '../../custom-action-registry.js'
import { createChildAddonCallDispatch } from '../../moleculer/child-addon-call-dispatch.js'

function withCatalog(handlerResult: unknown, seen: unknown[]) {
  const registry = new CustomActionRegistry()
  registry.registerAddon(
    'benchmark',
    {
      run: customAction(z.object({ iterations: z.number() }), z.object({ ran: z.number() })),
    },
    async (_action, input) => {
      seen.push(input)
      return handlerResult
    },
  )
  return createChildAddonCallDispatch({
    getRouteProvider: () => null,
    customActions: registry,
    getAddonInstance: () => null,
    getDataPlanes: () => [],
  })
}

describe('createChildAddonCallDispatch — custom actions validate where the schemas live', () => {
  it('refuses input the declared schema refuses, naming the action and the issue, and never calls the handler', async () => {
    const seen: unknown[] = []
    const dispatch = withCatalog({ ran: 1 }, seen)
    await expect(
      dispatch({
        addonId: 'benchmark',
        target: 'custom',
        action: 'run',
        args: { iterations: 'ten' },
      }),
    ).rejects.toThrow(/custom action "run" rejected its input — iterations:/)
    expect(seen).toHaveLength(0)
  })

  it('hands the handler the PARSED input and validates what the handler returns', async () => {
    const seen: unknown[] = []
    const dispatch = withCatalog({ ran: 'not a number' }, seen)
    await expect(
      dispatch({ addonId: 'benchmark', target: 'custom', action: 'run', args: { iterations: 3 } }),
    ).rejects.toThrow()
    expect(seen).toEqual([{ iterations: 3 }])
  })

  it('returns the validated result when both sides agree', async () => {
    const seen: unknown[] = []
    const dispatch = withCatalog({ ran: 3 }, seen)
    await expect(
      dispatch({ addonId: 'benchmark', target: 'custom', action: 'run', args: { iterations: 3 } }),
    ).resolves.toEqual({ ran: 3 })
  })
})
