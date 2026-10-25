/**
 * Product release version — the line of the container image, the desktop
 * app and the GitHub release. It is not an npm version. `@camstack/*` stay
 * on their own line; this file only names the product (D943).
 *
 * Plain node, zero deps: `release.yml`'s derive job does not `npm ci`.
 *
 * Usage (CI): node scripts/ci/product-release.mjs
 *   reads product-version.json + packages/desktop/package.json
 *   writes version= and release_name= to $GITHUB_OUTPUT
 */
import { appendFileSync, readFileSync } from 'node:fs'

const PRODUCT_FILE = 'product-version.json'
const DESKTOP_FILE = 'packages/desktop/package.json'
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * @param {string} version
 * @returns {string} `0.1.0 beta` while major is 0, otherwise the version
 */
export function productLabel(version) {
  return version.split('.')[0] === '0' ? `${version} beta` : version
}

/** @param {string} version */
export function productReleaseName(version) {
  return `CamStack ${productLabel(version)}`
}

/**
 * Shown on a 0.x GitHub release. electron-updater will not move a 1.2.x
 * install onto a lower version; the feed itself keeps working afterwards.
 *
 * @param {string} version
 * @returns {string | null}
 */
export function desktopDowngradeNote(version) {
  if (version.split('.')[0] !== '0') return null
  return (
    'Installs of the desktop app or the Electron viewer shell that are still on 1.2.x will not ' +
    'auto-update to this release (a lower semver). Reinstall those once; later releases on this ' +
    'line use the same update feeds. The viewer app (1.0.x) is a separate line and is not built here.'
  )
}

/**
 * @param {string} version
 * @param {string} kind `major` | `minor` | `patch`
 * @returns {string}
 */
export function bumpSemver(version, kind) {
  const match = SEMVER.exec(version)
  if (match === null) {
    throw new Error(`not an X.Y.Z version: ${version}`)
  }
  let major = Number(match[1])
  let minor = Number(match[2])
  let patch = Number(match[3])
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else if (kind === 'patch') {
    patch += 1
  } else {
    throw new Error(`unknown bump ${kind}`)
  }
  return `${major}.${minor}.${patch}`
}

/**
 * @param {{
 *   ref: string,
 *   refName: string,
 *   eventName: string,
 *   versionType: string,
 *   fileVersion: string,
 *   desktopVersion: string,
 * }} input
 * @returns {{ version: string, releaseName: string, problems: string[] }}
 */
export function deriveProductVersion(input) {
  const problems = []
  if (input.fileVersion !== input.desktopVersion) {
    problems.push(
      `product-version.json is ${input.fileVersion} but packages/desktop/package.json is ` +
        `${input.desktopVersion}. The desktop app version is the product version; they move together.`,
    )
  }
  if (!SEMVER.test(input.fileVersion)) {
    problems.push(`product-version.json version "${input.fileVersion}" is not X.Y.Z`)
  }
  if (problems.length > 0) {
    return { version: input.fileVersion, releaseName: '', problems }
  }

  const onTag = input.ref.startsWith('refs/tags/v')
  if (onTag) {
    const tagged = input.refName.startsWith('v') ? input.refName.slice(1) : input.refName
    if (tagged !== input.fileVersion) {
      problems.push(
        `tag v${tagged} does not match product-version.json ${input.fileVersion}. ` +
          'Bump product-version.json and packages/desktop/package.json to the tag, then tag that commit.',
      )
      return { version: tagged, releaseName: '', problems }
    }
    return { version: tagged, releaseName: productReleaseName(tagged), problems }
  }

  if (input.eventName === 'workflow_dispatch') {
    let bumped
    try {
      bumped = bumpSemver(input.fileVersion, input.versionType)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      problems.push(message)
      return { version: input.fileVersion, releaseName: '', problems }
    }
    return { version: bumped, releaseName: productReleaseName(bumped), problems }
  }

  return {
    version: input.fileVersion,
    releaseName: productReleaseName(input.fileVersion),
    problems,
  }
}

/** @param {string} file */
function readVersion(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed.version !== 'string') {
    throw new Error(`${file} has no string version`)
  }
  return parsed.version
}

function main() {
  const result = deriveProductVersion({
    ref: process.env.GITHUB_REF ?? '',
    refName: process.env.GITHUB_REF_NAME ?? '',
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    versionType: process.env.VERSION_TYPE ?? '',
    fileVersion: readVersion(PRODUCT_FILE),
    desktopVersion: readVersion(DESKTOP_FILE),
  })
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`::error::${problem}`)
    process.exit(1)
  }
  const lines = `version=${result.version}\nrelease_name=${result.releaseName}\n`
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output.length > 0) appendFileSync(output, lines)
  console.log(`product ${result.version} — ${result.releaseName}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invokedDirectly) main()
