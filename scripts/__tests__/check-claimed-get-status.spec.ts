/**
 * D663 / S3 — the claimed-getStatus guard, on fixtures.
 *
 * Every production file that resolves a cap call by name must ask the claim
 * authority (`answerClaimedGetStatus`) first, or be a named exception that is
 * downstream of an entry that did. Each shape goes red on the fixture that
 * breaks it; the last test runs the real tree.
 */
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import {
  checkClaimedGetStatusFacts,
  collectClaimedGetStatusFiles,
  type GuardFile,
  NAME_RESOLUTION_EXCEPTIONS,
} from '../claimed-get-status-guard.ts'
import { stripComments } from '../lib/walk-sources.ts'

/** A fixture as the walker would hand it over: comments blanked. */
const file = (rel: string, text: string): GuardFile => ({ rel, code: stripComments(text) })

describe('check-claimed-get-status rule', () => {
  it('passes an entry that asks before it resolves', () => {
    expect(
      checkClaimedGetStatusFacts([
        file(
          'packages/system/src/kernel/transport/some-entry.ts',
          'const c = await answerClaimedGetStatus(r, call); if (c) return c.slice; const d = await answerDeviceCallRedirect(h, call); if (d) return d.result; resolver.resolveCapRoute(cap, {})',
        ),
      ]),
    ).toEqual([])
  })

  it('refuses a new entry that resolves by name without asking — every resolution call, destructured and bracket forms included', () => {
    for (const call of [
      'resolver.resolveCapRoute(cap, o)',
      'reg.resolveChildId(cap, id)',
      'reg.callCapOnChild(id, input)',
      'reg.callCap(input)',
      "reg['callCapOnChild'](id, input)",
      'go2(); const { resolveCapRoute } = resolver; resolveCapRoute(cap, o)',
    ]) {
      const failures = checkClaimedGetStatusFacts([
        file(
          'server/backend/src/core/new-dispatcher.ts',
          `export async function go() { return ${call} }`,
        ),
      ])
      // One line per missing question: the claim authority and the redirect.
      expect(failures).toHaveLength(2)
      expect(failures[0]).toContain('server/backend/src/core/new-dispatcher.ts')
      expect(failures[0]).toContain('answerClaimedGetStatus')
      expect(failures[1]).toContain('answerDeviceCallRedirect')
    }
  })

  it('refuses an entry that asks the claim authority but not the device-call redirect (D963)', () => {
    const failures = checkClaimedGetStatusFacts([
      file(
        'packages/system/src/kernel/transport/half-entry.ts',
        'const c = await answerClaimedGetStatus(r, call); resolver.resolveCapRoute(cap, {})',
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('answerDeviceCallRedirect')
  })

  it('a mention in a COMMENT is not a call — neither the resolution nor the ask', () => {
    // Prose naming resolveCapRoute does not make the file an entry…
    expect(
      checkClaimedGetStatusFacts([
        file(
          'packages/system/src/kernel/x.ts',
          '// see resolver.resolveCapRoute(cap)\nexport const a = 1',
        ),
      ]),
    ).toEqual([])
    // …and prose naming the ask does not satisfy it.
    expect(
      checkClaimedGetStatusFacts([
        file(
          'packages/system/src/kernel/y.ts',
          '// answerClaimedGetStatus() answerDeviceCallRedirect() are called elsewhere\nresolver.resolveCapRoute(cap, {})',
        ),
      ]),
    ).toHaveLength(2)
  })

  it('tests and codegen output may resolve by name freely', () => {
    expect(
      checkClaimedGetStatusFacts([
        file('packages/system/src/kernel/__tests__/z.spec.ts', 'r.resolveCapRoute(cap, {})'),
        file('server/backend/src/api/trpc/generated-cap-routers.ts', 'r.resolveChildId(cap)'),
      ]),
    ).toEqual([])
  })

  it('every named exception passes, and each carries a reason', () => {
    const files = Object.keys(NAME_RESOLUTION_EXCEPTIONS).map((rel) =>
      file(rel, 'resolver.resolveCapRoute(cap, {})'),
    )
    expect(checkClaimedGetStatusFacts(files)).toEqual([])
    for (const reason of Object.values(NAME_RESOLUTION_EXCEPTIONS)) {
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  itRealTree(
    'the real tree passes — the three entries ask, the exceptions are the listed ones',
    () => {
      const files = collectClaimedGetStatusFiles()
      expect(files.length).toBeGreaterThan(1000)
      expect(checkClaimedGetStatusFacts(files)).toEqual([])
      // The three entries are on the tree and DO ask (a deleted hook would fail above).
      const asking = files
        .filter((f) => /\banswerClaimedGetStatus\(/.test(f.code))
        .map((f) => f.rel)
      expect(asking).toEqual(
        expect.arrayContaining([
          'packages/system/src/kernel/transport/local-child-registry.ts',
          'packages/system/src/kernel/transport/parent-unowned-call.ts',
          'server/backend/src/core/moleculer/moleculer.service.ts',
        ]),
      )
      const redirecting = files
        .filter((f) => /\banswerDeviceCallRedirect\(/.test(f.code))
        .map((f) => f.rel)
      expect(redirecting).toEqual(expect.arrayContaining(asking))
    },
  )
})
