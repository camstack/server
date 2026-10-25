/**
 * Load every `packages/types/src/capabilities/*.cap.ts` module — the input of
 * the extension-slot codegen and guard (D648). Kept apart from the pure model
 * (`extension-slots-model.ts`) so the model can be tested on fixtures.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CapModule } from './extension-slots-model.ts'

export const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
export const CAPS_DIR = path.join(REPO_ROOT, 'packages/types/src/capabilities')
export const EXTENSION_SLOTS_OUTPUT = path.join(
  REPO_ROOT,
  'packages/types/src/generated/extension-slots.ts',
)

export async function loadCapModules(): Promise<readonly CapModule[]> {
  const files = fs
    .readdirSync(CAPS_DIR)
    .filter((f) => f.endsWith('.cap.ts'))
    .toSorted()
  const out: CapModule[] = []
  for (const file of files) {
    const exports: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    out.push({ file, exports })
  }
  return out
}
