/**
 * The hub side of D444: a forked catalog is registered from the register-frame
 * DESCRIPTOR, never from the addon's bundle.
 *
 * Disarms, one per claim:
 *  - drop `auth`/`caller` from `toForkedCustomActionsSpec` → the first test
 *    loses the gate the hub enforces (`ensureCustomActionAuth`, caller
 *    forwarding);
 *  - replace `sortKeysDeep` with `JSON.stringify` → the fingerprint test
 *    sees two identities for one catalog.
 */
import { describe, expect, it } from 'vitest'
import {
  childCatalogsFingerprint,
  summarizeChildCatalogs,
  toForkedCustomActionsSpec,
} from '../forked-custom-actions.js'

describe('toForkedCustomActionsSpec', () => {
  it('keeps kind/auth/scope/caller and gives the hub PASSTHROUGH schemas', () => {
    const spec = toForkedCustomActionsSpec({
      run: { kind: 'mutation', auth: 'admin', scope: { kind: 'system' }, caller: 'required' },
      status: { kind: 'query', auth: 'protected', scope: { kind: 'system' } },
    })
    expect(spec['run']).toMatchObject({
      kind: 'mutation',
      auth: 'admin',
      scope: { kind: 'system' },
      caller: 'required',
    })
    expect(spec['status']).not.toHaveProperty('caller')
    // The runner owns the real schemas; the hub's parse must refuse nothing.
    expect(spec['run']!.input.parse({ anything: 'goes', n: 'not a number' })).toEqual({
      anything: 'goes',
      n: 'not a number',
    })
    expect(spec['run']!.output.parse(undefined)).toBeUndefined()
  })
})

describe('childCatalogsFingerprint', () => {
  it('is the same identity whatever order the runner enumerated its maps in', () => {
    const a = childCatalogsFingerprint({
      benchmark: { run: { kind: 'query', auth: 'protected', scope: { kind: 'system' } } },
      'model-studio': {},
    })
    const b = childCatalogsFingerprint({
      'model-studio': {},
      benchmark: { run: { scope: { kind: 'system' }, auth: 'protected', kind: 'query' } },
    })
    expect(a).toBe(b)
  })

  it('changes when a catalog changes — a re-register with new actions is not a no-op', () => {
    const before = childCatalogsFingerprint({ benchmark: {} })
    const after = childCatalogsFingerprint({
      benchmark: { run: { kind: 'query', auth: 'protected', scope: { kind: 'system' } } },
    })
    expect(before).not.toBe(after)
  })
})

describe('summarizeChildCatalogs', () => {
  it('names the addons WITH actions and, separately, the ones that declared none', () => {
    expect(
      summarizeChildCatalogs({
        'model-studio': {},
        benchmark: {
          run: { kind: 'query', auth: 'protected', scope: { kind: 'system' } },
          status: { kind: 'query', auth: 'protected', scope: { kind: 'system' } },
        },
      }),
    ).toEqual({ withActions: ['benchmark:2'], withoutActions: ['model-studio'] })
  })
})
