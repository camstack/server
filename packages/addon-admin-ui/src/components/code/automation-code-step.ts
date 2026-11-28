/** What an automation "Run code" step's code is checked against, and its starter. */
import type { EditorExtraLib } from './CodeEditor'

/**
 * Declares what a step's code can see. `ctx` is the block context: the type the
 * generated block receives (`export default function block(ctx: AddonContext)`).
 */
export const STEP_AMBIENT_LIB: EditorExtraLib = {
  filePath: 'file:///automation-step-ambient.d.ts',
  content: [
    "declare const ctx: import('@dominevo/types').AddonContext",
    "/** The run's variable bag. */",
    'declare const vars: Record<string, unknown>',
    '',
  ].join('\n'),
}

/**
 * TS diagnostics that only mean "this is a function body, not a module":
 * 1108 `return` outside a function, 1375 / 1378 top-level `await`,
 * 1208 / 1446 file is not a module.
 */
export const STEP_IGNORED_DIAGNOSTICS: readonly number[] = [1108, 1208, 1375, 1378, 1446]

/** Libs the editor is checked against: the hub's type libs plus the step's ambient names. */
export function stepExtraLibs(hubLibs: readonly EditorExtraLib[]): readonly EditorExtraLib[] {
  return [...hubLibs, STEP_AMBIENT_LIB]
}

/** Starter for a new step: valid, executes nothing, shows the three things a step does. */
export const CODE_STEP_TEMPLATE = `// Runs inside this automation. In scope: ctx (the block context) and vars (the run's variables).

// Read and write a variable for the steps that follow:
// const previous = vars['counter']
// vars['counter'] = typeof previous === 'number' ? previous + 1 : 1

// Call a device command through the API:
// await ctx.api.switch.setState.mutate({ deviceId: 123, on: true })

// Write to the log:
// ctx.logger.info('step reached', { counter: vars['counter'] })
`
