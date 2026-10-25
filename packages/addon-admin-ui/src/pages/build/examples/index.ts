/**
 * Starter multi-file projects an operator can load into a new script.
 *
 * These are TEMPLATES — they are not installed on the hub. Copy into the
 * editor, fill settings, Save + Restart. Each uses only Node builtins +
 * `@camstack/types` (no npm packages in the block bundle).
 *
 * Homelab-specific scripts (UniFi WAN check, TV schedule scrape, …) stay on
 * the hub only — never as repo templates.
 */

import i18n from '../../../i18n/index'

export interface ScriptExample {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly entry: string
  readonly files: Readonly<Record<string, string>>
}

export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  {
    id: 'blank',
    name: 'Blank script',
    get description() {
      return i18n.t('helpers.buildExamples.blankDescription')
    },
    entry: 'main.ts',
    files: {
      'main.ts': `import type { AddonContext } from '@camstack/types'

/**
 * A core block. Runs in its own process, with the same \`ctx\` an addon gets.
 * Return a function to release whatever you took (timers, sockets, listeners).
 *
 * Declaring devices: import { reconcileBlockDevices, exposeBlockDevices } from
 * '@camstack/types' and hang them off the shared Blocks integration.
 */
export default function block(ctx: AddonContext) {
  ctx.logger.info('hello from a core block')

  const timer = setInterval(() => {
    ctx.logger.info('tick')
  }, 60_000)

  return () => {
    clearInterval(timer)
  }
}
`,
    },
  },
]

export function scriptExampleById(id: string): ScriptExample | undefined {
  return SCRIPT_EXAMPLES.find((e) => e.id === id)
}

/** Next unused path for a new empty file (`file.ts`, `file-2.ts`, …). */
export function nextScriptFilePath(existing: ReadonlySet<string> | readonly string[]): string {
  const taken = existing instanceof Set ? existing : new Set(existing)
  if (!taken.has('file.ts')) return 'file.ts'
  let n = 2
  while (taken.has(`file-${String(n)}.ts`)) n += 1
  return `file-${String(n)}.ts`
}
