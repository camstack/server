/**
 * Cap-name ⇄ router-key round-trip guard, at the transport layer.
 *
 * A forked addon's `ctx.api` is a tRPC proxy whose property names are the
 * CAMEL router keys (`kebabToCamel(cap.name)` — `addon-context-factory.ts`).
 * The transport has to recover the cap's REGISTERED name from that key, and
 * it does so with a pure string transform: `parsePath()` in `trpc-links.ts`
 * runs `toKebab(namespace)`. That transform is the exact inverse of
 * `kebabToCamel` only while every cap name is kebab-case.
 *
 * `recordingExport` (camelCase) broke it: `kebabToCamel('recordingExport')`
 * is the identity, so the proxy key was right, but `toKebab('recordingExport')`
 * produced `recording-export` — a name no provider ever registers. EVERY
 * forked-addon `ctx.api.recordingExport.*` call died at the parent with
 * `no provider registered for cap "recording-export"`, while the hub's own
 * tRPC router (which mounts by key, never re-deriving a name) worked fine.
 *
 * This asserts the invariant over the REAL cap set, through the real link, so
 * the next camelCase cap name fails here instead of in production.
 */
import { describe, it, expect } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS, kebabToCamel } from '@camstack/types'
import { ipcParentLink } from '../../moleculer/trpc-links.js'
import type { CapCallInput } from '../../transport/index.js'

/** Drive one op through `ipcParentLink` and return the `CapCallInput` it put on the wire. */
async function capturedCallInput(path: string): Promise<CapCallInput> {
  let captured: CapCallInput | null = null
  const callOut = async (input: CapCallInput): Promise<unknown> => {
    captured = input
    return null
  }
  const link = ipcParentLink(() => callOut)({} as never)
  await new Promise<void>((resolve, reject) => {
    link({
      op: { id: 1, type: 'query', path, input: undefined, context: {}, signal: null as never },
      next: () => {
        throw new Error(`ipcParentLink delegated instead of calling out for "${path}"`)
      },
    } as never).subscribe({
      next: () => resolve(),
      error: (err: unknown) => reject(err as Error),
      complete: () => resolve(),
    })
  })
  if (captured === null) throw new Error(`no call-out captured for "${path}"`)
  return captured
}

describe('cap name ⇄ router key round-trip', () => {
  it('every capability name survives kebabToCamel → ipcParentLink unchanged', async () => {
    const broken: string[] = []
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      const routerKey = kebabToCamel(def.name)
      const { capName } = await capturedCallInput(`${routerKey}.someMethod`)
      if (capName !== def.name) broken.push(`${def.name} → ctx.api.${routerKey} → "${capName}"`)
    }
    expect(
      broken,
      'a cap name the transport cannot recover from its ctx.api router key — ' +
        'every forked-addon call to it fails with "no provider registered". ' +
        'Cap names must be kebab-case (see check-cap-name-kebab.ts).',
    ).toEqual([])
  })

  it('recovers the cap name and method for a plain kebab cap', async () => {
    await expect(capturedCallInput('motionZones.getStatus')).resolves.toMatchObject({
      capName: 'motion-zones',
      method: 'getStatus',
    })
  })

  it('recovers a single-word cap name', async () => {
    await expect(capturedCallInput('ptz.move')).resolves.toMatchObject({
      capName: 'ptz',
      method: 'move',
    })
  })
})
