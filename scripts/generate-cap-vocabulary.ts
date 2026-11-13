#!/usr/bin/env tsx
/**
 * Codegen: the cap vocabulary (D920, D1050).
 *
 * Emits `packages/types/src/generated/cap-vocabulary.ts` — one entry per
 * capability, projected from what each `*.cap.ts` declares: actions on their
 * methods, event wording on their events, the rest in the cap's `vocabulary`
 * block. The map is typed `CapVocabularyMap`, so a method, status field, arg
 * or event a declaration names that its cap does not have is a TypeScript
 * error here. Plain data: no cap module (and no Zod graph) reaches a bundle
 * that reads the vocabulary.
 *
 * Run manually: npx tsx scripts/generate-cap-vocabulary.ts
 */
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.ts'
import { writeIfChanged } from './codegen-write.ts'
import { projectCapVocabularies } from './lib/cap-vocabulary-project.ts'
import { quote, vocabLiteralBlock } from './lib/cap-vocabulary-literal.ts'
import { parseAllCaps } from './lib/parse-cap.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/cap-vocabulary.ts')

function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'name') === 'string' &&
    typeof Reflect.get(value, 'methods') === 'object'
  )
}

async function loadDefinitions(): Promise<readonly CapabilityDefinition[]> {
  const out: CapabilityDefinition[] = []
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def = mod[info.exportName]
    if (isCapabilityDefinition(def)) out.push(def)
  }
  return out
}

async function main(): Promise<void> {
  const projected = projectCapVocabularies(await loadDefinitions())
  const body = projected
    .map(
      ({ cap, entry }) =>
        `  ${quote(cap)}: ${vocabLiteralBlock(entry, 'object', 2, undefined, 4 + cap.length + 4)},`,
    )
    .join('\n')
  const device = projected.filter((p) => p.order !== null).length
  const out = `// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-cap-vocabulary.ts
/* eslint-disable */

import { DeviceRole, DeviceType } from '../device/device-type.js'
import type { CapVocabularyMap } from '../device/cap-vocabulary/types.js'
import { EventCategory } from '../enums/event-category.js'

/**
 * THE cap vocabulary (D920), projected from the declarations of every
 * \`*.cap.ts\` (D1050): ${projected.length} caps (${device} device, ${projected.length - device} system).
 * Device caps in their declared picker order, then system caps by name.
 */
export const CAP_VOCABULARY: CapVocabularyMap = {
${body}
}
`
  writeIfChanged(OUTPUT, out)
  // eslint-disable-next-line no-console
  console.log(`cap vocabulary → ${path.relative(ROOT, OUTPUT)} (${projected.length} caps)`)
}

void main()
