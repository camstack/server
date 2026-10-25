/**
 * The one-shot notifier guard (D692). Each rule is proved red on the exact shape
 * that brought the follow-up back in D142/D143, and green on the shapes that
 * must stay legal. The real tree is not walked here: the CI repository-guards
 * step runs the guard over it.
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOW_LIST,
  findRetiredNameViolations,
  findStaleAllowances,
  findTagViolations,
  isAllowed,
} from '../check-nc-one-shot.js'
import { stripComments } from '../lib/walk-sources.js'

const DISPATCHER = 'packages/addon-post-analysis/src/notification-center/dispatcher.ts'
const ELSEWHERE = 'packages/addon-post-analysis/src/notification-center/rule-engine.ts'

describe('dispatcher builds no tag', () => {
  it('flags a tag property in an object literal', () => {
    expect(findTagViolations('send({ body, tag: entry.key })', DISPATCHER)).toHaveLength(1)
  })

  it('flags a conditional spread of a tag', () => {
    expect(findTagViolations('...(x ? { tag: y } : {})', DISPATCHER)).toHaveLength(1)
  })

  it('flags a quoted tag key', () => {
    expect(findTagViolations("send({ 'tag': k })", DISPATCHER)).toHaveLength(1)
  })

  it('reports the line', () => {
    const [hit] = findTagViolations('a\nb\nconst n = { tag: k }', DISPATCHER)
    expect(hit?.line).toBe(3)
  })

  it('does not flag a tag in a comment', () => {
    expect(findTagViolations(stripComments('// tag: x\n/* tag: y */'), DISPATCHER)).toHaveLength(0)
  })

  it('does not flag an optional declaration', () => {
    expect(findTagViolations('readonly tag?: string', DISPATCHER)).toHaveLength(0)
  })
})

describe('no follow-up vocabulary outside the allow-list', () => {
  it('flags :enhanced in a template key', () => {
    expect(findRetiredNameViolations('const k = `${trackId}:enhanced`', ELSEWHERE)).toHaveLength(1)
  })

  it('flags groupIdleSec', () => {
    expect(findRetiredNameViolations('rule.groupIdleSec', ELSEWHERE)).toHaveLength(1)
  })

  it('lets every allow-listed file name them', () => {
    for (const a of ALLOW_LIST) {
      expect(findRetiredNameViolations('groupIdleSec :enhanced', a.file)).toHaveLength(0)
    }
  })

  it('lets the viewer checkout name them until the pin bump', () => {
    expect(isAllowed('camstack/src/app/rules.tsx')).toBe(true)
  })

  it('does not allow a sibling of an allow-listed file', () => {
    expect(
      isAllowed('packages/addon-post-analysis/src/notification-center/rule-store.test.ts'),
    ).toBe(false)
  })
})

describe('an allowance nothing needs is a hole', () => {
  it('flags every entry whose file names no retired key', () => {
    const clean = new Map(ALLOW_LIST.map((a) => [a.file, 'export const x = 1']))
    expect(findStaleAllowances(clean)).toHaveLength(ALLOW_LIST.length)
  })

  it('flags an entry whose file is gone', () => {
    expect(findStaleAllowances(new Map())).toHaveLength(ALLOW_LIST.length)
  })

  it('accepts entries that still name one', () => {
    const live = new Map(ALLOW_LIST.map((a) => [a.file, 'const k = "groupIdleSec"']))
    expect(findStaleAllowances(live)).toHaveLength(0)
  })
})
