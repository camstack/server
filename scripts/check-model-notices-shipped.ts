#!/usr/bin/env tsx
/**
 * Model-notice guard: every package that DOWNLOADS model weights, or carries
 * the code that does, ships the third-party model notice, byte-identical to
 * the root copy, and the Docker image bakes it in.
 *
 * ## The failure this catches
 *
 * Apache-2.0 §4, MIT, CC BY, the Apple AMLR agreement and the Llama 3.2 licence
 * all ask for the notice to travel WITH the thing distributed. CamStack's
 * weights are fetched by code in these packages; the npm tarball and the
 * Docker image are what users receive. npm only auto-includes README/LICENSE,
 * so a notice that is not in `files` silently never ships. A copy that drifts
 * from the root file ships a stale attribution, which is worse than none
 * because it reads as done.
 *
 * Source of the notice: `THIRD_PARTY_MODELS.md`, generated from the catalog
 * licence records by `scripts/gen-model-licenses.ts` (D661), which imports the
 * constants below — so `main()` runs only when this file is the entry point.
 *
 * Usage: npx tsx scripts/check-model-notices-shipped.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

export const NOTICE_FILE = 'THIRD_PARTY_MODELS.md'
export const LICENSE_TEXTS_DIR = 'licenses/models'
export const NOTICE_PACKAGES: readonly string[] = [
  'packages/addon-pipeline',
  'packages/addon-post-analysis',
  'packages/addon-ai',
  'packages/addon-model-studio',
  'server/backend',
]

interface PackageJson {
  readonly name?: string
  readonly license?: string
  readonly files?: readonly string[]
}

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPackageJson(dir: string): PackageJson {
  const raw: unknown = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'))
  if (!isPackageJson(raw)) throw new Error(`${dir}/package.json is not an object`)
  return raw
}

function readText(rel: string): string | null {
  const abs = path.join(ROOT, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

function checkPackages(rootNotice: string | null): readonly string[] {
  const problems: string[] = []
  for (const dir of NOTICE_PACKAGES) {
    const pkg = readPackageJson(dir)
    if (!(pkg.files ?? []).includes(NOTICE_FILE)) {
      problems.push(
        `${dir}/package.json: "files" does not include "${NOTICE_FILE}", so npm will not ship it`,
      )
    }
    if (pkg.license !== 'MIT') {
      problems.push(
        `${dir}/package.json: "license" is ${JSON.stringify(pkg.license)}, expected "MIT"`,
      )
    }
    const copy = readText(path.join(dir, NOTICE_FILE))
    if (copy === null) {
      problems.push(`${dir}/${NOTICE_FILE} is missing`)
    } else if (rootNotice !== null && copy !== rootNotice) {
      problems.push(
        `${dir}/${NOTICE_FILE} differs from the root ${NOTICE_FILE}; copy the root file over it`,
      )
    }
  }
  return problems
}

/**
 * Every licence text the notice cites must exist. The generator cites one as
 * `` (`<name>.txt`) `` after the licence it holds; any other backticked `.txt`
 * (the AGPL source offer names `requirements.txt` in the mirror's `source/`)
 * is not a licence text.
 */
function checkCitedTexts(rootNotice: string): readonly string[] {
  const dir = path.join(ROOT, LICENSE_TEXTS_DIR)
  const present = new Set(existsSync(dir) ? readdirSync(dir) : [])
  const cited = new Set([...rootNotice.matchAll(/\(`([A-Za-z0-9.-]+\.txt)`\)/g)].map((m) => m[1]))
  return [...cited]
    .filter((name) => name !== undefined && !present.has(name))
    .map((name) => `${NOTICE_FILE} cites \`${name}\`, which is not in ${LICENSE_TEXTS_DIR}/`)
}

function checkImage(): readonly string[] {
  const problems: string[] = []
  const dockerfile = readText('Dockerfile') ?? ''
  const dockerignore = readText('.dockerignore') ?? ''
  if (!dockerfile.includes('org.opencontainers.image.licenses')) {
    problems.push('Dockerfile: the runtime stage has no org.opencontainers.image.licenses label')
  }
  if (
    !/^COPY [^\n]*\bTHIRD_PARTY_MODELS\.md\b[^\n]*\/usr\/share\/doc\/camstack\//m.test(dockerfile)
  ) {
    problems.push(`Dockerfile: no COPY of ${NOTICE_FILE} into /usr/share/doc/camstack/`)
  }
  if (
    !/^COPY licenses\/models\/ \/usr\/share\/doc\/camstack\/licenses\/models\/$/m.test(dockerfile)
  ) {
    problems.push(
      `Dockerfile: no COPY of ${LICENSE_TEXTS_DIR}/ into /usr/share/doc/camstack/licenses/models/`,
    )
  }
  for (const entry of [`!${NOTICE_FILE}`, '!LICENSE', `!${LICENSE_TEXTS_DIR}/**`]) {
    if (!dockerignore.split('\n').includes(entry)) {
      problems.push(
        `.dockerignore: "${entry}" missing, so the build context would not carry the file the Dockerfile COPYs`,
      )
    }
  }
  return problems
}

function main(): void {
  const rootNotice = readText(NOTICE_FILE)
  const problems = [
    ...(rootNotice === null ? [`${NOTICE_FILE} is missing at the repo root`] : []),
    ...checkPackages(rootNotice),
    ...(rootNotice === null ? [] : checkCitedTexts(rootNotice)),
    ...checkImage(),
  ]
  if (problems.length > 0) {
    console.error('\n✗ model notices are not shipped\n')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(
    `✓ model notices: ${NOTICE_PACKAGES.length} packages ship ${NOTICE_FILE}, identical to the root copy; the image bakes it with ${LICENSE_TEXTS_DIR}/`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
