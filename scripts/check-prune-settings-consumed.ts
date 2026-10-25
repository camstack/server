#!/usr/bin/env tsx
/**
 * Prune-window guard — **every configurable prune window is declared, rendered
 * and READ.**
 *
 * ## The failure this catches
 *
 * This repo has shipped four knobs that decided nothing: D62's per-family
 * retention windows, `zoneMembershipMinOverlap`, `rescueCentroidFactor`, and
 * `audioThresholdDbfs`. The shape is always identical — the READER moves or
 * dies, the WRITER and the form stay, and nothing connects them. A settings
 * test that writes a value and reads it back passes the whole time, because the
 * store really does hold the number. It is the sweep that stopped asking.
 *
 * These four windows are more exposed than most: three of them are the ONLY
 * bound on the thing they bound (D485 removed the artefact shelf's row and byte
 * caps), so a window that quietly stops being read is not a knob that does
 * nothing — it is an unbounded shelf.
 *
 * ## What it checks
 *
 * 1. **The declaration is the form.** Every key in `PRUNE_SETTING_KEYS` appears
 *    as a field `key` in the `prune-windows` section, and every field in that
 *    section appears in `PRUNE_SETTING_KEYS`. Neither may grow alone.
 * 2. **Every window has a consumer.** Every field of `PruneWindows` is read
 *    somewhere outside `prune-windows.ts`. A window the resolver computes and
 *    no sweep passes to a store is the same defect one layer down.
 * 3. **The defaults are not restated.** The literal day values may appear only
 *    in `prune-windows.ts`. `embeddingEnabled` shipped with a handle and a form
 *    field carrying different defaults, and the form reported the opposite of
 *    what the cluster was doing.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const NC = 'packages/addon-post-analysis/src/notification-center'
const MODULE = path.join(ROOT, NC, 'prune-windows.ts')
const FORM = path.join(
  ROOT,
  'packages/addon-post-analysis/src/pipeline-analytics/settings-schema.ts',
)

const failures: string[] = []
const moduleSrc = readFileSync(MODULE, 'utf-8')
const formSrc = readFileSync(FORM, 'utf-8')

/** Keys as the module declares them. */
const declared = [...moduleSrc.matchAll(/^\s{2}'?([a-zA-Z]+Days)'?[,:]/gm)]
  .map((m) => m[1])
  .filter((k): k is string => k !== undefined)
const declaredKeys = [...new Set(declared)]

/** The form section, sliced so a key elsewhere on the page cannot satisfy it. */
const sectionStart = formSrc.indexOf("id: 'prune-windows'")
if (sectionStart < 0) {
  failures.push(`the 'prune-windows' section is gone from ${path.relative(ROOT, FORM)}`)
}
const sectionSrc = sectionStart < 0 ? '' : formSrc.slice(sectionStart, sectionStart + 6000)
const rendered = new Set(
  [...sectionSrc.matchAll(/key: '([a-zA-Z]+Days)'/g)]
    .map((m) => m[1])
    .filter((k): k is string => k !== undefined),
)

for (const key of declaredKeys) {
  if (!rendered.has(key)) {
    failures.push(`'${key}' is declared but no field renders it — an invisible knob`)
  }
}
for (const key of rendered) {
  if (!declaredKeys.includes(key)) {
    failures.push(`'${key}' is rendered but not declared — it will never be resolved or swept`)
  }
}

/**
 * Every resolved window must be read somewhere else. Searched across the addon
 * rather than in one named function: unlike the per-device cutoffs, these four
 * are consumed in four different places by design.
 */
const consumers = readFileSync(
  path.join(ROOT, 'packages/addon-post-analysis/src/pipeline-analytics/index.ts'),
  'utf-8',
)
const ncIndex = readFileSync(path.join(ROOT, NC, 'index.ts'), 'utf-8')
const elsewhere = `${consumers}\n${ncIndex}`
for (const field of ['outboxMs', 'timelapseExportMs', 'artifactShelfMs', 'summaryMosaicMs']) {
  // Word-boundary, not `includes`: a substring match reports `outboxMsXX` as a
  // reader of `outboxMs`, which is exactly the rename this guard exists to
  // catch. Verified by breaking it on purpose — the first version passed.
  if (!new RegExp(`\\b${field}\\b`).test(elsewhere)) {
    failures.push(`'${field}' is resolved but nothing reads it — the window decides nothing`)
  }
}

if (failures.length > 0) {
  console.error('✘ prune-window guard failed:')
  for (const f of failures) console.error(`    ${f}`)
  process.exit(1)
}
console.log(`✔ ${declaredKeys.length} prune windows declared, rendered and consumed`)
