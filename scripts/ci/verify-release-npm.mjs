#!/usr/bin/env node
/**
 * verify-release-npm — the release workflow's npm-contract gate. Runs at the
 * top of `release.yml`'s `derive-version` job (plain node, zero deps — the
 * job does not `npm ci`), BEFORE any image or installer build starts.
 *
 * The product tag (`vX.Y.Z`) and `@camstack/server` are different lines
 * (D943). Both the Docker image and the desktop app install
 * `@camstack/server@latest` (Dockerfile, packages/desktop/scripts/stage-deps.mjs).
 * This gate resolves that dist-tag and records it. It does not ask `latest`
 * to equal the product version: that was the coupled contract, and a product
 * `0.1.0` baking server `1.2.x` is the success case.
 *
 * A missing `latest` still fails closed. Without it the release cannot say
 * which closure it baked, which is the failure the image label exists to
 * prevent.
 *
 * Usage: node scripts/ci/verify-release-npm.mjs <product-version>
 *   writes server_version= to $GITHUB_OUTPUT
 */
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PACKAGE = '@camstack/server'
const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * @param {{ productVersion: string, latestVersion: string | null }} inputs
 * @returns {{ problems: string[], serverVersion: string | null }}
 */
export function assessReleaseNpm({ productVersion, latestVersion }) {
  const problems = []

  if (!SEMVER.test(productVersion)) {
    problems.push(
      `product version "${productVersion}" is not X.Y.Z. The tag is the product release ` +
        '(image, desktop app, GitHub release), not an npm version and not a pre-release suffix.',
    )
  }

  if (latestVersion === null || latestVersion.length === 0) {
    problems.push(
      `could not resolve the dist-tag \`latest\` for ${PACKAGE}. The image and the desktop app ` +
        `both install ${PACKAGE}@latest, so a release that does not know what \`latest\` resolves ` +
        'to cannot record which closure it bakes. Fix the registry lookup and re-run.',
    )
    return { problems, serverVersion: null }
  }

  return { problems, serverVersion: latestVersion }
}

/** `npm view` a single field; null when npm errors or prints nothing. */
function npmView(spec, field) {
  try {
    const out = execFileSync('npm', ['view', spec, field], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

function main() {
  const productVersion = process.argv[2]
  if (productVersion === undefined || productVersion.length === 0) {
    console.error('usage: node scripts/ci/verify-release-npm.mjs <product-version>')
    process.exit(2)
  }
  console.log(`Resolving ${PACKAGE} dist-tag \`latest\` for product ${productVersion}…`)
  const latestVersion = npmView(PACKAGE, 'dist-tags.latest')
  const result = assessReleaseNpm({ productVersion, latestVersion })
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`::error::${problem}`)
    process.exit(1)
  }
  const serverVersion = result.serverVersion ?? ''
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output.length > 0) {
    appendFileSync(output, `server_version=${serverVersion}\n`)
  }
  console.log(`OK — product ${productVersion} will bake ${PACKAGE}@${serverVersion} (npm latest).`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) main()
