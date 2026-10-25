/**
 * The trainer's vendored code must be byte-identical to its source.
 *
 * `hf/camstack-trainer/camstack_train/_vendor/` carries two copies, because the
 * trainer image is built from the Hugging Face repo alone and cannot reach this
 * repository:
 *
 * - `camstack_eval/` = `scripts/eval/camstack_eval/` (the P5 evaluation
 *   harness: metrics, the D739 floor rule, the comparison);
 * - `pipeline_python/` = `packages/addon-pipeline/python/` `inference_pool.py`
 *   (with `pool_platform.py` and `webgpu_isolated.py`, which it imports at
 *   module level) and `postprocessors/*.py` (tests excluded): the letterbox and
 *   decode the harness imports, so a cloud evaluation scores exactly as a node
 *   runs.
 *
 * A copy that drifted would make the trainer's floors and its comparison
 * disagree with the hub's own measurement while every test stayed green on
 * both sides. Fix by re-copying the source, never by editing the copy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'hf/camstack-trainer/camstack_train/_vendor')

export interface VendorPair {
  /** Source folder, relative to the repository root. */
  readonly source: string
  /** Vendored folder, relative to `_vendor/`. */
  readonly copy: string
  /** Which source files are vendored. */
  readonly include: (name: string) => boolean
}

const isPython = (name: string): boolean => name.endsWith('.py')
const isShippedPython = (name: string): boolean => isPython(name) && !name.startsWith('test_')

const PIPELINE_VENDORED: ReadonlySet<string> = new Set([
  'inference_pool.py',
  'pool_platform.py',
  'webgpu_isolated.py',
])

export const VENDOR_PAIRS: readonly VendorPair[] = [
  { source: 'scripts/eval/camstack_eval', copy: 'camstack_eval', include: isPython },
  {
    source: 'packages/addon-pipeline/python',
    copy: 'pipeline_python',
    // The pool and the sibling modules it imports AT MODULE LEVEL — importing
    // `inference_pool` in the trainer fails without them. (Its function-level
    // imports — edgetpu_*, coreml_*, openvino_* probes — are hardware paths the
    // trainer's CPU evaluation never reaches.)
    include: (name) => PIPELINE_VENDORED.has(name),
  },
  {
    source: 'packages/addon-pipeline/python/postprocessors',
    copy: 'pipeline_python/postprocessors',
    include: isShippedPython,
  },
]

function listFiles(dir: string, include: (name: string) => boolean): readonly string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => include(name) && statSync(join(dir, name)).isFile())
    .toSorted()
}

/** Every difference between a source folder and its vendored copy. */
export function vendorProblems(root: string, vendor: string, pair: VendorPair): readonly string[] {
  const sourceDir = join(root, pair.source)
  const copyDir = join(vendor, pair.copy)
  const sourceFiles = listFiles(sourceDir, pair.include)
  const copyFiles = listFiles(copyDir, pair.include)
  const problems: string[] = []
  if (sourceFiles.length === 0) problems.push(`${pair.source}: no source files found`)
  for (const name of sourceFiles) {
    if (!copyFiles.includes(name)) {
      problems.push(`${pair.copy}/${name}: missing (source ${pair.source}/${name})`)
    } else if (!readFileSync(join(sourceDir, name)).equals(readFileSync(join(copyDir, name)))) {
      problems.push(`${pair.copy}/${name}: differs from ${pair.source}/${name}`)
    }
  }
  for (const name of copyFiles) {
    if (!sourceFiles.includes(name)) {
      problems.push(`${pair.copy}/${name}: no longer exists in ${pair.source}`)
    }
  }
  return problems
}

/**
 * Module-level (column 0) `import x` / `from x import …` of a vendored file
 * that names a SIBLING source module the pair does not vendor: the copy would
 * fail to import in the trainer while every byte-compare stayed green.
 */
export function unvendoredSiblingImports(root: string, pair: VendorPair): readonly string[] {
  const sourceDir = join(root, pair.source)
  const problems: string[] = []
  for (const name of listFiles(sourceDir, pair.include)) {
    const text = readFileSync(join(sourceDir, name), 'utf8')
    for (const m of text.matchAll(/^(?:from|import)\s+(\w+)/gm)) {
      const mod = m[1]
      if (mod === undefined || mod === '__future__') continue
      const sibling = `${mod}.py`
      if (existsSync(join(sourceDir, sibling)) && !pair.include(sibling)) {
        problems.push(
          `${pair.source}/${name}: imports \`${mod}\` at module level, but ${pair.copy}/${sibling} is not vendored`,
        )
      }
    }
  }
  return problems
}

function main(): void {
  const problems = VENDOR_PAIRS.flatMap((pair) => [
    ...vendorProblems(ROOT, VENDOR, pair),
    ...unvendoredSiblingImports(ROOT, pair),
  ])
  if (problems.length > 0) {
    console.error('✘ the trainer vendors code that drifted from its source:')
    for (const p of problems) console.error(`    ${p}`)
    console.error(
      '  Re-copy the source into hf/camstack-trainer/camstack_train/_vendor/ (never edit the copy).',
    )
    process.exit(1)
  }
  console.log('✔ the trainer vendor copies match scripts/eval and addon-pipeline/python')
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) main()
