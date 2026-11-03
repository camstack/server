import { describe, expect, it } from 'vitest'
import { THE_CALLER, callersOf, checkSingleCaller } from '../check-single-composition-creator'

const hook = 'const create = useCoreBlocksCreateComposition()\n'

describe('check-single-composition-creator', () => {
  it('passes with the wrapper as the only caller', () => {
    const callers = callersOf([
      { rel: THE_CALLER, content: `return ${hook}` },
      { rel: 'packages/addon-admin-ui/src/a.tsx', content: 'const c = useCreateComposition()\n' },
    ])
    expect(checkSingleCaller(callers)).toEqual([])
  })

  it('flags a second file reaching the generated hook', () => {
    const callers = callersOf([
      { rel: THE_CALLER, content: hook },
      { rel: 'packages/addon-admin-ui/src/pages/Shortcut.tsx', content: hook },
    ])
    expect(checkSingleCaller(callers)).toHaveLength(1)
  })

  it('ignores comment lines, and notices a wrapper that stopped calling', () => {
    const callers = callersOf([{ rel: 'x.ts', content: ' * useCoreBlocksCreateComposition\n' }])
    expect(callers).toEqual([])
    expect(checkSingleCaller(callers)).toHaveLength(1)
  })
})
