/**
 * D663 — the field-claims guard, on fixtures.
 *
 * The claim contract has a closed set of definers: the cap, its generated
 * routers, the device-manager's claim methods and index, and the composer that
 * claims. Anyone else naming `claimFields` / `patchOwnedFields` / `releaseClaim`
 * is a second writer of a field's authority (D62). And the row key `'$owned'`
 * is spelled in ONE module; everyone else imports `OWNED_FIELDS_KEY`, so a
 * consumer cannot grow its own reading of the row. Each rule goes red on the
 * fixture that breaks it; the last test runs the real tree.
 */
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import {
  checkFieldClaimFacts,
  collectFieldClaimFiles,
  type GuardFile,
} from '../field-claims-guard.ts'
import { stripComments } from '../lib/walk-sources.ts'

/** A fixture as the walker would hand it over: comments blanked. */
const file = (rel: string, text: string): GuardFile => ({ rel, code: stripComments(text) })

describe('check-field-claims rules', () => {
  it('passes the definers of the contract', () => {
    expect(
      checkFieldClaimFacts([
        file('packages/types/src/capabilities/device-state.cap.ts', 'claimFields: method('),
        file('packages/types/src/generated/capability-router-map.ts', 'claimFields'),
        file('server/backend/src/api/trpc/generated-cap-routers.ts', 'p.claimFields('),
        file('packages/system/src/builtins/device-manager/device-state-claims.ts', 'claimFields:'),
        file('packages/system/src/builtins/composer/composer.ts', 'deviceState.claimFields.mutate'),
        file(
          'packages/system/src/builtins/device-manager/field-ownership.ts',
          "const K = '$owned'",
        ),
        file('packages/system/src/builtins/x/__tests__/y.spec.ts', "claimFields '$owned'"),
        file('scripts/check-field-claims.ts', 'claimFields'),
      ]),
    ).toEqual([])
  })

  it('the addon and the index are not producers — the methods live in device-state-claims.ts', () => {
    const failures = checkFieldClaimFacts([
      file(
        'packages/system/src/builtins/device-manager/device-manager.addon.ts',
        'claimFields: async () => {}',
      ),
      file(
        'packages/system/src/builtins/device-manager/field-claims-index.ts',
        'this.releaseClaim()',
      ),
    ])
    expect(failures).toHaveLength(2)
  })

  it('refuses a provider that claims: a second writer of a field it does not own', () => {
    const failures = checkFieldClaimFacts([
      file(
        'packages/addon-provider-reolink/src/x.ts',
        'await api.deviceState.claimFields.mutate(i)',
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/packages\/addon-provider-reolink\/src\/x\.ts/)
    expect(failures[0]).toMatch(/claimFields/)
  })

  it('refuses the mirror spelling the row key — it imports OWNED_FIELDS_KEY', () => {
    const failures = checkFieldClaimFacts([
      file('packages/system/src/builtins/device-manager/device-state-mirror.ts', "blob['$owned']"),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/device-state-mirror\.ts/)
    expect(failures[0]).toMatch(/\$owned/)
  })

  it('a comment naming the method is not a reference', () => {
    expect(
      checkFieldClaimFacts([
        file(
          'packages/addon-x/src/y.ts',
          '// the composer calls claimFields\n/* and "$owned" */\nconst a = 1',
        ),
      ]),
    ).toEqual([])
  })

  itRealTree('the real tree passes', () => {
    expect(checkFieldClaimFacts(collectFieldClaimFiles())).toEqual([])
  })
})
