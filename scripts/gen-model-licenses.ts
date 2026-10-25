#!/usr/bin/env tsx
/**
 * Generate every model-licence surface from the catalogs — the ONE source of
 * truth (D661):
 *
 *   THIRD_PARTY_MODELS.md + the package copies                  the product notice
 *   hf/camstack-models/README.md, between the table markers     the HF model table
 *
 * Operator-facing "Models and licenses" lives in the public docs
 * (`camstack/docs` → `/docs/detection/models`), not in the Admin UI.
 *
 * `--check` fails on drift instead of writing (CI). The output carries no
 * timestamp: it must be byte-stable for `--check`.
 *
 * Usage: npm run models:notices            (write)
 *        tsx scripts/gen-model-licenses.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { ModelCatalogEntry } from '../packages/types/src/types/models.js'
import {
  ALL_PIPELINE_STEPS,
  DORMANT_PIPELINE_STEPS,
} from '../packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.js'
import { NOTICE_FILE, NOTICE_PACKAGES } from './check-model-notices-shipped.js'
import {
  builtInCatalogEntries,
  type CatalogSource,
  HF_MIRROR_PREFIX,
  hostedFolders,
} from './lib/model-catalogs.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const HF_README = 'hf/camstack-models/README.md'
const BEGIN = '<!-- BEGIN GENERATED MODEL TABLE -->'
const END = '<!-- END GENERATED MODEL TABLE -->'

export type ModelHostingValue = 'camstack-hf' | 'third-party' | 'built-in'

export interface ModelLicenseRowTrainingData {
  readonly name: string
  readonly terms: string
  readonly url: string | null
}

export interface ModelLicenseRowData {
  readonly id: string
  readonly name: string
  /** Step ids the model serves, or `clip-text` / `llm`. */
  readonly steps: readonly string[]
  /** The default of at least one active step (for at least one format). */
  readonly isDefault: boolean
  /** Hidden from selection, kept resolvable. */
  readonly legacy: boolean
  readonly weights: string
  readonly code: string | null
  readonly data: ModelLicenseRowTrainingData | null
  readonly upstreamName: string
  readonly upstreamUrl: string
  readonly licenseUrl: string
  readonly attribution: string | null
  readonly modifications: string | null
  readonly hosting: ModelHostingValue
  readonly nonCommercial: boolean
  /** `<category>/<model>` folders of the CamStack HF mirror the model downloads from. */
  readonly mirrorFolders: readonly string[]
  /** Every other place a node downloads it from (`https://host/org/repo`). */
  readonly otherSources: readonly string[]
  /** The file under `licenses/models/` holding the weights' terms, when CamStack ships one. */
  readonly licenceText: string | null
}

/** Full texts shipped in `licenses/models/`, by SPDX id of the weights. */
const LICENCE_TEXTS: Readonly<Record<string, string>> = {
  'AGPL-3.0': 'AGPL-3.0.txt',
  'GPL-3.0': 'GPL-3.0.txt',
  'Apache-2.0': 'Apache-2.0.txt',
  'BSD-3-Clause': 'BSD-3-Clause.txt',
  'CC-BY-4.0': 'CC-BY-4.0.txt',
  'CC-BY-NC-4.0': 'CC-BY-NC-4.0.txt',
  'LicenseRef-Llama-3.2-Community': 'Llama-3.2-Community.txt',
}

/** An MIT notice names its copyright holder, so each MIT upstream has its own file. */
const MIT_TEXT_BY_UPSTREAM: Readonly<Record<string, string>> = {
  'ankandrew/fast-plate-ocr': 'MIT-fast-plate-ocr.txt',
  'OpenCV Zoo YuNet': 'MIT-yunet-reference.txt',
}

/** Terms with no text CamStack can ship: unknown, or the OS vendor's own licence. */
const NO_TEXT = new Set(['UNKNOWN', 'LicenseRef-Apple-macOS'])

const STEP_TITLES: Readonly<Record<string, string>> = {
  'object-detection': 'Object detection',
  'package-detection': 'Package detection',
  'face-detection': 'Face detection',
  'face-embedding': 'Face recognition',
  'plate-detection': 'Licence plate detection',
  'plate-ocr': 'Licence plate reading',
  'animal-classifier': 'Animal classifier',
  'bird-classifier': 'Bird classifier',
  'vehicle-classifier': 'Vehicle classifier',
  'clip-embedding': 'Semantic search, image encoders (CLIP)',
  'clip-text': 'Semantic search, text encoders (CLIP)',
  segmentation: 'Segmentation',
  'instance-segmentation': 'Instance segmentation (dormant step)',
  'audio-classifier': 'Audio',
  llm: 'Language and vision-language models (AI addon)',
}

const STEP_ORDER: readonly string[] = Object.keys(STEP_TITLES)

function licenceTextFor(weights: string, upstreamName: string): string | null {
  if (NO_TEXT.has(weights)) return null
  const text = weights === 'MIT' ? MIT_TEXT_BY_UPSTREAM[upstreamName] : LICENCE_TEXTS[weights]
  if (text === undefined) {
    throw new Error(
      `no licence text for weights "${weights}" (upstream "${upstreamName}"): add the file to licenses/models/ and map it in scripts/gen-model-licenses.ts`,
    )
  }
  return text
}

/** `https://host/org/repo/...` → `https://host/org/repo`: the repository a file comes from. */
function sourceOf(url: string): string {
  const u = new URL(url)
  const parts = u.pathname.split('/').filter((p) => p.length > 0)
  return `${u.origin}/${parts.slice(0, 2).join('/')}`
}

function otherSources(entry: ModelCatalogEntry): readonly string[] {
  const urls = [
    ...Object.values(entry.formats).map((f) => f?.url ?? ''),
    ...(entry.extraFiles ?? []).map((f) => f.url),
  ]
  return [
    ...new Set(
      urls.filter((u) => u.startsWith('https://') && !u.startsWith(HF_MIRROR_PREFIX)).map(sourceOf),
    ),
  ]
}

function toRow(
  e: ModelCatalogEntry,
  steps: readonly string[],
  isDefault: boolean,
): ModelLicenseRowData {
  const l = e.license
  if (!l?.upstream || !l.url || !l.hosting) {
    throw new Error(`${e.id}: incomplete licence — run scripts/check-catalog-licence.ts`)
  }
  return {
    id: e.id,
    name: e.name,
    steps,
    isDefault,
    legacy: e.legacy === true,
    weights: l.weights,
    code: l.code ?? null,
    data: l.data ? { name: l.data.name, terms: l.data.terms, url: l.data.url ?? null } : null,
    upstreamName: l.upstream.name,
    upstreamUrl: l.upstream.url,
    licenseUrl: l.url,
    attribution: l.attribution ?? null,
    modifications: l.modifications ?? null,
    hosting: l.hosting,
    nonCommercial: l.nonCommercial === true,
    mirrorFolders: l.hosting === 'camstack-hf' ? hostedFolders(e) : [],
    otherSources: otherSources(e),
    licenceText: licenceTextFor(l.weights, l.upstream.name),
  }
}

/**
 * Where a catalog's rows go in the notice. `excluded` keeps a catalog OUT of
 * the notice: Model Studio's catalogs are third-party models it imports on
 * the operator's request, straight from their publishers. CamStack neither
 * hosts nor redistributes them, so the notice names them only in prose ("Your
 * own models"). Their licence records stay in Model Studio, which shows them,
 * and `check-catalog-licence.ts` still requires every entry to declare one.
 */
const FIXED_STEPS: Readonly<Record<CatalogSource, string | null | 'excluded'>> = {
  detection: null,
  'clip-image': 'clip-embedding',
  'clip-text': 'clip-text',
  llm: 'llm',
  'model-studio-plugin-catalog': 'excluded',
  'model-studio-plus-catalog': 'excluded',
}

export function buildRows(): readonly ModelLicenseRowData[] {
  const stepsOf = new Map<string, readonly string[]>()
  const defaults = new Set<string>()
  for (const s of [...ALL_PIPELINE_STEPS, ...DORMANT_PIPELINE_STEPS]) {
    const def = s.definition
    for (const m of def.models) stepsOf.set(m.id, [...(stepsOf.get(m.id) ?? []), def.id])
  }
  for (const s of ALL_PIPELINE_STEPS) {
    defaults.add(s.definition.defaultModelId)
    for (const id of Object.values(s.definition.defaultModelIdByFormat ?? {})) defaults.add(id)
  }
  const seen = new Set<string>()
  const rows: ModelLicenseRowData[] = []
  for (const { source, entry } of builtInCatalogEntries()) {
    const fixed = FIXED_STEPS[source]
    if (fixed === 'excluded' || seen.has(entry.id)) continue
    seen.add(entry.id)
    const steps = stepsOf.get(entry.id) ?? (fixed === null ? [] : [fixed])
    rows.push(toRow(entry, steps, defaults.has(entry.id)))
  }
  // Catalog order within a step; steps in STEP_TITLES order. (A module
  // namespace lists its exports alphabetically, so the walk alone would put
  // "Animal classifier" first.)
  const rank = (r: ModelLicenseRowData): number => {
    const i = STEP_ORDER.indexOf(r.steps[0] ?? '')
    return i === -1 ? STEP_ORDER.length : i
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r)
}

// ── Rendering ────────────────────────────────────────────────────────────────

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function code(ids: readonly string[]): string {
  return ids.map((id) => `\`${id}\``).join(', ')
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function rowLabel(r: ModelLicenseRowData): string {
  const tags = [r.isDefault ? 'default' : null, r.legacy ? 'hidden' : null].filter(
    (t): t is string => t !== null,
  )
  return tags.length > 0 ? `\`${r.id}\` (${tags.join(', ')})` : `\`${r.id}\``
}

function withText(licence: string, text: string | null | undefined): string {
  return text === null || text === undefined ? licence : `${licence} (\`${text}\`)`
}

function termsOf(r: ModelLicenseRowData): string {
  const codePart =
    r.code === null ? '—' : r.code === r.weights ? r.code : withText(r.code, LICENCE_TEXTS[r.code])
  const weights =
    r.weights === 'UNKNOWN' ? '**Unknown**' : r.nonCommercial ? `**${r.weights}**` : r.weights
  return `${codePart} / ${withText(weights, r.licenceText)}`
}

function dataOf(r: ModelLicenseRowData): string {
  return r.data === null ? '—' : `${r.data.name}: ${r.data.terms}`
}

function sourcesOf(r: ModelLicenseRowData): string {
  if (r.hosting === 'built-in') return 'built in, nothing downloaded'
  const mirror = r.mirrorFolders.map((f) => `mirror \`${f}\``)
  return [...mirror, ...r.otherSources].join(' · ')
}

interface RowGroup {
  readonly key: string
  readonly rows: readonly ModelLicenseRowData[]
}

/** Rows that differ only in id / variant collapse into one table row. */
function groupRows(rows: readonly ModelLicenseRowData[]): readonly RowGroup[] {
  const groups = new Map<string, ModelLicenseRowData[]>()
  for (const r of rows) {
    const key = [
      r.upstreamName,
      r.weights,
      r.code ?? '',
      r.data?.name ?? '',
      r.hosting,
      r.nonCommercial,
      r.mirrorFolders.join(','),
      r.otherSources.join(','),
    ].join('\u0000')
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.entries()].map(([key, rs]) => ({ key, rows: rs }))
}

function stepOrder(rows: readonly ModelLicenseRowData[]): readonly string[] {
  return unique(rows.map((r) => r.steps[0] ?? 'other'))
}

function renderModelTables(rows: readonly ModelLicenseRowData[]): string {
  const out: string[] = []
  for (const step of stepOrder(rows)) {
    out.push(`### ${STEP_TITLES[step] ?? step}`, '')
    out.push(
      '| Catalog ids | Upstream | Code / weights | Training data | CamStack changes | Downloaded from |',
    )
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const g of groupRows(rows.filter((r) => (r.steps[0] ?? 'other') === step))) {
      const first = g.rows[0]
      if (first === undefined) continue
      const mods = unique(g.rows.map((r) => r.modifications ?? 'none')).join('; ')
      out.push(
        `| ${g.rows.map(rowLabel).join(', ')} | [${cell(first.upstreamName)}](${first.upstreamUrl}) | ${cell(termsOf(first))} | ${cell(dataOf(first))} | ${cell(mods)} | ${cell(sourcesOf(first))} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

function attributionsOf(rows: readonly ModelLicenseRowData[]): readonly string[] {
  return unique(rows.map((r) => r.attribution).filter((a): a is string => a !== null))
}

function renderAttributions(rows: readonly ModelLicenseRowData[]): string {
  return attributionsOf(rows)
    .map((a) => {
      const upstreams = unique(rows.filter((r) => r.attribution === a).map((r) => r.upstreamUrl))
      return `- ${a} ${upstreams.join(' · ')}`
    })
    .join('\n')
}

/** Training data whose terms ask for attribution (CC BY and the like), once each. */
function renderDataAttributions(rows: readonly ModelLicenseRowData[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const r of rows) {
    if (r.data === null || !/CC[- ]BY/i.test(r.data.terms) || seen.has(r.data.name)) continue
    seen.add(r.data.name)
    const url = r.data.url === null ? '' : ` ${r.data.url}`
    const users = rows.filter((x) => x.data?.name === r.data?.name).map((x) => x.id)
    const who = users.length > 1 ? `\`${r.id}\` and ${users.length - 1} more` : `\`${r.id}\``
    lines.push(`- **${r.data.name}** (training data of ${who}): ${r.data.terms}.${url}`)
  }
  return lines.join('\n')
}

function renderNonCommercial(rows: readonly ModelLicenseRowData[]): string {
  const lines = ['| Model | Used for | Terms |', '| --- | --- | --- |']
  for (const r of rows.filter((x) => x.nonCommercial)) {
    const terms = r.data === null ? r.weights : `${r.weights}; training data: ${r.data.terms}`
    lines.push(
      `| ${rowLabel(r)} | ${cell(STEP_TITLES[r.steps[0] ?? ''] ?? r.steps.join(', '))} | ${cell(terms)} ([terms](${r.licenseUrl})) |`,
    )
  }
  return lines.join('\n')
}

function agplFolders(rows: readonly ModelLicenseRowData[]): readonly string[] {
  return unique(rows.filter((r) => r.weights === 'AGPL-3.0').flatMap((r) => r.mirrorFolders))
}

export function renderNotice(rows: readonly ModelLicenseRowData[]): string {
  const folders = agplFolders(rows)
  const folderList = `${code(folders.slice(0, -1))} and ${code(folders.slice(-1))}`
  return `<!--
  THIRD_PARTY_MODELS.md: the product notice for every model CamStack can download.

  GENERATED by scripts/gen-model-licenses.ts from the licence records on the model
  catalogs (D661). Do not edit it: change the record in the catalog
  (packages/addon-pipeline/src/detection-pipeline/registry/model-licenses.ts,
  packages/addon-post-analysis/src/embedding-encoder/catalogs/model-licenses.ts,
  packages/addon-ai/src/runtime/llm-model-licenses.ts), then run npm run models:notices.
  The package copies (${NOTICE_PACKAGES.join(', ')}) are byte-identical
  (npm cannot ship a file from outside the package); the Hugging Face mirror receives
  the same file from hf/camstack-models/upload.sh. Drift fails CI.
  Facts: planning repo superpowers/specs/2026-09-26-model-license-compliance.md. Not legal advice.
-->

# Third-party models

CamStack's own source code is MIT-licensed (see \`LICENSE\`). CamStack does not
include model weights in its npm packages or its Docker image. It downloads
them, on demand, from the locations listed below. **Each model stays under its
own licence.** Converting a model to another format does not change its
licence: every CamStack-made build is a modified version (a "model derivative")
of the upstream weights, and the change is stated per model.

Full licence texts: \`licenses/models/\` in the CamStack source repository, and
[\`LICENSES/\`](https://huggingface.co/camstack/camstack-models/tree/main/LICENSES)
in the model mirror https://huggingface.co/camstack/camstack-models.

Some of these models are **not licensed for commercial use**. They are listed
under [Non-commercial models](#non-commercial-models).

## Required attributions

${renderAttributions(rows)}

Training data under attribution terms:

${renderDataAttributions(rows)}

## Source offer for the AGPL-3.0 weights

<!--
  This section is the ONE place the source offer is written. The package copies are
  byte-identical copies of this file, and the Hugging Face model card, its LICENSE and its folder
  cards link here instead of repeating it.
-->

The folders ${folderList} of the model mirror hold Ultralytics weights,
modified by CamStack and distributed under AGPL-3.0. Their Corresponding Source
is published in the mirror itself, in its **\`source/\`** folder,
**https://huggingface.co/camstack/camstack-models/tree/main/source**, together
with the upstream checkpoints it starts from:

1. **The upstream checkpoints.** Ultralytics publishes
   \`yolo26{n,s,m,l,x}.pt\`, \`yolov9{t,s,m,c}.pt\` and \`yolo26{n,s,m}-seg.pt\` at
   https://github.com/ultralytics/assets/releases.
2. **The build script** in \`source/\`: \`build-camstack-models.py\`, with
   \`convert_lib.py\` (the ONNX to OpenVINO / INT8 converter it calls, the same
   file CamStack's Model Studio runs) and \`requirements.txt\`. It holds one
   recipe per hosted file: the upstream checkpoint, the input size, the
   Ultralytics \`export()\` arguments, the OpenVINO precision and the INT8
   calibration count that file records about itself. Every hosted
   Ultralytics-derived file is rebuilt by one invocation:
   \`build-camstack-models.py --variant <file stem>\` (for example
   \`camstack-yolo26n-320\` or \`camstack-yolov9m-640\`), \`--family <folder>\`
   or \`--all\`; \`--list\` prints the recipes and \`--check-hosted\` confirms
   against the mirror that every hosted file is a recipe output. The INT8
   builds are NNCF post-training quantisation calibrated on COCO images: 128
   for YOLO26, 300 for YOLOv9, as each IR records; the documented set is the
   first N of COCO val2017 in file-name order. The Python
   environment, the recorded tool versions and the calibration set are in
   \`source/README.md\` and the script's header. These scripts are CamStack's
   own code and are offered under the MIT licence; the weights they produce
   keep their upstream licence.

Limits of a rebuild:

- **Tool versions.** With the Ultralytics, PyTorch, coremltools and OpenVINO
  versions each recipe names, a rebuild reproduces the hosted weights. Other
  versions give the same weights in a possibly different graph.
- **INT8 calibration.** An IR records how many images calibrated it, not
  which ones. Calibrating on the same COCO images gives the documented build;
  a different set gives an equivalent, not bit-identical, INT8 model.

## Non-commercial models

These are downloaded by default or selectable, and their terms **do not allow
commercial use**:

${renderNonCommercial(rows)}

## Models

"Mirror" means https://huggingface.co/camstack/camstack-models, folder given.
"Code / weights" gives the two licences separately because they often differ.
**Unknown** means no licence could be traced; it does not mean free to use.
*default* marks the model a step runs when nobody chose one; *hidden* marks an
entry kept resolvable for a saved selection but no longer offered.

${renderModelTables(rows)}
### Your own models

Model Studio can import third-party models (for example community
object-detection catalogs) on request. They are downloaded from their
publishers, are not hosted or redistributed by CamStack, and keep their
publishers' licences; Model Studio shows the licence where the source declares
one. A model you upload or convert
yourself, or pull from your own plus catalog account, likewise keeps whatever
licence its author published. CamStack does not change it and does not record
it.
`
}

export function renderHfTable(rows: readonly ModelLicenseRowData[]): string {
  const hosted = rows.filter((r) => r.hosting === 'camstack-hf')
  const folders = unique(hosted.flatMap((r) => r.mirrorFolders))
  const lines = [
    '| Folder | Catalog ids | Upstream | Weights licence | Licence text | CamStack modifications |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const folder of folders) {
    const rs = hosted.filter((r) => r.mirrorFolders.includes(folder))
    const first = rs[0]
    if (first === undefined) continue
    const weights = unique(
      rs.map((r) =>
        r.weights === 'UNKNOWN' ? '**Unknown**' : r.nonCommercial ? `**${r.weights}**` : r.weights,
      ),
    )
    const texts = unique(
      rs.flatMap((r) => [
        r.licenceText,
        r.code !== null && r.code !== r.weights ? (LICENCE_TEXTS[r.code] ?? null) : null,
      ]),
    ).filter((t): t is string => t !== null)
    const mods = unique(rs.map((r) => r.modifications ?? 'none')).join('; ')
    lines.push(
      `| \`${folder}\` | ${cell(rs.map(rowLabel).join(', '))} | ${cell(unique(rs.map((r) => r.upstreamName)).join('; '))} | ${cell(weights.join(', '))} | ${texts.length === 0 ? 'none' : texts.map((t) => `[\`${t}\`](LICENSES/${t})`).join(', ')} | ${cell(mods)} |`,
    )
  }
  return lines.join('\n')
}

// ── Main ─────────────────────────────────────────────────────────────────────

function read(rel: string): string | null {
  const abs = path.join(ROOT, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

function outputs(rows: readonly ModelLicenseRowData[]): ReadonlyMap<string, string> {
  const hfCurrent = read(HF_README) ?? ''
  const [head, rest] = hfCurrent.split(BEGIN)
  const tail = rest?.split(END)[1]
  if (head === undefined || tail === undefined) {
    throw new Error(`${HF_README}: the ${BEGIN} / ${END} markers are missing`)
  }
  const notice = renderNotice(rows)
  return new Map<string, string>([
    [NOTICE_FILE, notice],
    ...NOTICE_PACKAGES.map((d): [string, string] => [path.join(d, NOTICE_FILE), notice]),
    [HF_README, `${head}${BEGIN}\n${renderHfTable(rows)}\n${END}${tail}`],
  ])
}

function main(): void {
  const check = process.argv.includes('--check')
  const rows = buildRows()
  const files = outputs(rows)
  const drift: string[] = []
  for (const [rel, content] of files) {
    if (read(rel) === content) continue
    if (check) drift.push(rel)
    else writeFileSync(path.join(ROOT, rel), content)
  }
  if (drift.length > 0) {
    console.error(
      `✗ model licence surfaces are stale — run npm run models:notices:\n  ${drift.join('\n  ')}`,
    )
    process.exit(1)
  }
  console.log(
    check
      ? `✓ model licence surfaces up to date (${files.size} files, ${rows.length} catalog rows)`
      : `wrote ${files.size} files from ${rows.length} catalog rows`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
