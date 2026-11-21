import { describe, expect, it } from 'vitest'
import { markPureInitializers } from '../../tools/build/pure-initializers.js'

const PURE = '/* @__PURE__ */ '

describe('markPureInitializers', () => {
  it('marks the call of a top-level initializer, exported or not', () => {
    const src = 'const A = z.object({})\nexport const B = make(1)\n'
    expect(markPureInitializers(src).code).toBe(
      `const A = ${PURE}z.object({})\nexport const B = ${PURE}make(1)\n`,
    )
  })

  it('marks the outermost call of a chain once, and calls nested in the arguments', () => {
    const out = markPureInitializers('const A = z.object({ a: z.string() }).extend({}).readonly()')
    expect(out.code).toBe(
      `const A = ${PURE}z.object({ a: ${PURE}z.string() }).extend({}).readonly()`,
    )
  })

  it('never marks a bare expression statement (the event taxonomy is built by them)', () => {
    const src = "macro('system', 'System booted')\nsub('a', 'b')\n"
    expect(markPureInitializers(src)).toEqual({ code: src, count: 0 })
  })

  it('never marks inside a function body, nor an IIFE', () => {
    const src = 'const A = () => make(1)\nconst B = (() => { register(); return 1 })()\n'
    expect(markPureInitializers(src)).toEqual({ code: src, count: 0 })
  })

  it('marks a new expression in an initializer', () => {
    expect(markPureInitializers('const A = new Map()').code).toBe(`const A = ${PURE}new Map()`)
  })
})
