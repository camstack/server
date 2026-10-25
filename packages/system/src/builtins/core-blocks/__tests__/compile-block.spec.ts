/**
 * Compiling a block before it is stored.
 *
 * The point of this module is that the editor and the store reach the SAME
 * verdict. Every test is about the compile giving an answer the author can act
 * on rather than throwing something a log will swallow.
 */
import { describe, expect, it } from 'vitest'
import { type BlockTranspiler, compileBlock } from '../compile-block.js'

/** A transpiler that behaves like esbuild for the two cases that matter. */
const esbuildLike: BlockTranspiler = {
  transform: async (code) => {
    if (code.includes('SYNTAX ERROR')) {
      // esbuild throws an object carrying `errors[].text` + `.location`.
      throw Object.assign(new Error('Transform failed'), {
        errors: [{ text: 'Unexpected "ERROR"', location: { line: 3, column: 7 } }],
      })
    }
    return { code: code.replace(/: \w+/g, '') }
  },
}

describe('compileBlock', () => {
  it('emits JavaScript for source that compiles', async () => {
    const res = await compileBlock(esbuildLike, 'export default async function (ctx: unknown) {}')
    expect(res.ok).toBe(true)
    expect(res.js).toContain('export default')
  })

  it('returns the failure as an ANSWER, never a throw', async () => {
    // A thrown error here becomes a 500 with the useful part buried; the author
    // needs to read the message, in the editor, now.
    const res = await compileBlock(esbuildLike, 'const x = SYNTAX ERROR')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Unexpected')
  })

  it('carries the POSITION, so the editor can put the cursor on it', async () => {
    const res = await compileBlock(esbuildLike, 'const x = SYNTAX ERROR')
    expect(res.line).toBe(3)
    expect(res.column).toBe(7)
  })

  it('refuses empty source — a transpiler accepts it, a runner cannot start it', async () => {
    // Better answered here than by a fork that finds nothing to call.
    const res = await compileBlock(esbuildLike, '   \n  ')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('empty')
  })

  it('survives a transpiler that throws something shapeless', async () => {
    const hostile: BlockTranspiler = {
      transform: async () => {
        throw 'not an error object'
      },
    }
    const res = await compileBlock(hostile, 'export default 1')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not an error object')
  })
})
