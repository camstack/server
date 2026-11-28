import { AutomationActionSchema, generateAutomationBlock } from '@dominevo/types'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { newAction } from '../../../pages/build/automation/recipe-parts'
import {
  CODE_STEP_TEMPLATE,
  STEP_AMBIENT_LIB,
  STEP_IGNORED_DIAGNOSTICS,
  stepExtraLibs,
} from '../automation-code-step'

describe('automation code step', () => {
  it('a new code step is prefilled with the template and is a valid action', () => {
    const action = newAction('code')
    expect(action).toEqual({ kind: 'code', code: CODE_STEP_TEMPLATE })
    expect(AutomationActionSchema.safeParse(action).success).toBe(true)
  })

  it('the template shows vars, a device command and the logger', () => {
    expect(CODE_STEP_TEMPLATE).toContain("vars['")
    expect(CODE_STEP_TEMPLATE).toContain('ctx.api.switch.setState.mutate')
    expect(CODE_STEP_TEMPLATE).toContain('ctx.logger.info')
  })

  it('the template survives codegen as a syntactically valid block', () => {
    const generated = generateAutomationBlock({
      name: 'T',
      recipe: {
        when: { kind: 'manual' },
        actions: [{ kind: 'code', code: CODE_STEP_TEMPLATE }],
      },
    })
    const out = ts.transpileModule(String(generated), {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    })
    expect(out.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([])
  })

  it('declares ctx as the block AddonContext and vars as the run bag, after the hub libs', () => {
    expect(STEP_AMBIENT_LIB.content).toContain(
      "declare const ctx: import('@dominevo/types').AddonContext",
    )
    expect(STEP_AMBIENT_LIB.content).toContain('declare const vars: Record<string, unknown>')
    const hub = { filePath: 'file:///node_modules/x/index.d.ts', content: '' }
    expect(stepExtraLibs([hub])).toEqual([hub, STEP_AMBIENT_LIB])
  })

  it('ignores the diagnostics of a function body checked as a script', () => {
    expect(STEP_IGNORED_DIAGNOSTICS).toEqual(expect.arrayContaining([1108, 1375, 1378]))
  })
})
