/**
 * D663 — the composed-methods guard, on fixtures (final review M-10).
 *
 * `composedMethods` is how a composed device answers a method it cannot
 * forward yet. A key that is not one of the cap's methods is never read; an
 * `answer` that fails the method's output schema is served anyway. Each rule
 * goes red on the fixture that breaks it; the last test runs the real tree.
 */
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import { z } from 'zod'
import { ALL_CAPABILITY_DEFINITIONS } from '../../packages/types/src/generated/capability-router-map.js'
import { method } from '../../packages/types/src/capabilities/capability-definition.js'
import { checkComposedMethods, type ComposedMethodsSubject } from '../composed-methods-guard.ts'

const wake = method(
  z.object({ deviceId: z.number() }),
  z.object({ awoke: z.boolean(), durationMs: z.number() }),
)

function cap(composedMethods: ComposedMethodsSubject['composedMethods']): ComposedMethodsSubject {
  return { name: 'fixture', methods: { wakeForStream: wake }, composedMethods }
}

describe('check-composed-methods rules', () => {
  it('passes an answer that parses and a refusal', () => {
    expect(
      checkComposedMethods([
        cap({ wakeForStream: { kind: 'answer', value: { awoke: false, durationMs: 0 } } }),
        cap({ wakeForStream: { kind: 'refuse', reason: 'not until slice 3' } }),
        cap(undefined),
      ]),
    ).toEqual([])
  })

  it('refuses a key that is not a method of the cap — it would never be read', () => {
    const failures = checkComposedMethods([
      cap({ wakeForStreem: { kind: 'refuse', reason: 'typo' } }),
    ])
    expect(failures).toEqual([
      "fixture.composedMethods.wakeForStreem: 'wakeForStreem' is not a method of 'fixture'",
    ])
  })

  it("refuses an answer that fails the method's own output schema", () => {
    const failures = checkComposedMethods([
      cap({ wakeForStream: { kind: 'answer', value: { awoke: 'no' } } }),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(
      /^fixture\.composedMethods\.wakeForStream: the 'answer' value fails fixture\.methods\.wakeForStream\.output\.safeParse/,
    )
  })

  itRealTree('the real tree passes, and at least one cap declares composedMethods', () => {
    expect(checkComposedMethods(ALL_CAPABILITY_DEFINITIONS)).toEqual([])
    expect(ALL_CAPABILITY_DEFINITIONS.some((d) => d.composedMethods !== undefined)).toBe(true)
  })
})
