#!/usr/bin/env tsx
/**
 * Viewer-build guard — the reduced product stays reduced, and owns its own name.
 *
 * ── What this prevents ─────────────────────────────────────────────────────
 * The desktop shell builds TWO products from one source tree (D402). The fat
 * one stages, into `Resources/`, a full Node 24 binary and the entire
 * `@camstack/server` closure — system/types/sdk/ui-library, every
 * `addon-*`, fastify/moleculer/zod/winston, and native prebuilds for
 * better-sqlite3, node-av and sharp. The viewer product runs NONE of it: its
 * role spawns no node process. That is the whole reason it exists.
 *
 * Nothing about that is self-enforcing. `extraResources` is a JSON array in a
 * config file; a copy-paste from the fat config, or an `extends` that inherits
 * it, restores the closure silently and the "reduced" build stops being
 * reduced — with no failure anywhere, just a download that is hundreds of
 * megabytes bigger than the thing it replaced.
 *
 * The second half is a scar, not a hypothetical. The release workflow matches
 * build outputs by GLOB. Two matrix legs once shared `CamStack-*`, and one
 * architecture's DMG overwrote the other's on the v1.2.3 release. A viewer
 * artifact named `CamStack-…` would do it again, to a different pair.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *  1. the viewer config declares `extraResources: []` — present and empty,
 *     never absent (absent inherits nothing here, but it also says nothing,
 *     and this file is where the intent is recorded);
 *  2. it does not `extends` another config, which is how the closure would
 *     come back without appearing in the diff;
 *  3. its `artifactName` does not start with `CamStack-`;
 *  4. its `appId` differs from the fat product's, so both install side by side;
 *  5. the `dist:viewer:*` scripts do not run `stage-deps` — the step that
 *     downloads the runtime and installs the closure in the first place.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DESKTOP = path.join(ROOT, 'packages/desktop')
const VIEWER_CONFIG = path.join(DESKTOP, 'electron-builder.viewer.json')
const PACKAGE_JSON = path.join(DESKTOP, 'package.json')
const RELEASE_WORKFLOW = path.join(ROOT, '.github/workflows/release.yml')

interface ViewerConfigShape {
  readonly extends?: unknown
  readonly extraResources?: unknown
  readonly extraMetadata?: unknown
  readonly artifactName?: unknown
  readonly appId?: unknown
}

interface DesktopPackageShape {
  readonly scripts?: Readonly<Record<string, string>>
  readonly build?: { readonly appId?: unknown }
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function main(): void {
  const violations: string[] = []

  if (!fs.existsSync(VIEWER_CONFIG)) {
    // eslint-disable-next-line no-console
    console.error(
      `\n\x1b[31m✘ viewer-build guard failed\x1b[0m\n    - ${path.relative(ROOT, VIEWER_CONFIG)} is gone; the reduced product has no config\n`,
    )
    process.exit(1)
  }

  const viewer = readJson(VIEWER_CONFIG) as ViewerConfigShape
  const pkg = readJson(PACKAGE_JSON) as DesktopPackageShape

  const extraResources = viewer.extraResources
  if (!Array.isArray(extraResources)) {
    violations.push('`extraResources` is missing — declare it as an empty array, explicitly')
  } else if (extraResources.length > 0) {
    violations.push(
      `\`extraResources\` has ${extraResources.length} entry/entries — the viewer stages nothing; that is the product`,
    )
  }

  if (viewer.extends !== null && viewer.extends !== undefined) {
    violations.push('`extends` is set — an inherited config is how the server closure comes back')
  }

  const artifactName = viewer.artifactName
  if (typeof artifactName !== 'string' || artifactName.length === 0) {
    violations.push('`artifactName` is missing — the release workflow matches artifacts by glob')
  } else if (artifactName.startsWith('CamStack-')) {
    violations.push(
      `\`artifactName\` is "${artifactName}" — it collides with the fat product's CamStack-* glob (the v1.2.3 overwrite)`,
    )
  }

  const fatAppId = pkg.build?.appId
  if (typeof viewer.appId !== 'string' || viewer.appId.length === 0) {
    violations.push('`appId` is missing')
  } else if (viewer.appId === fatAppId) {
    violations.push(
      `\`appId\` equals the fat product's ("${viewer.appId}") — the two could not be installed side by side`,
    )
  }

  // The closure has TWO ways in. `extraResources` is the loud one; this is the
  // quiet one, and it is the one that actually bit: `packages/desktop`
  // declares `@camstack/server` as a runtime DEPENDENCY, and electron-builder
  // bundles production dependencies into `app.asar` whether or not anything
  // imports them. Measured 2026-09-09 on the first viewer build: a 246 MB DMG
  // whose asar held node-av (60 MB), @seydx (59 MB), sharp (17 MB) and
  // better-sqlite3 (12 MB) — with `extraResources: []` and this guard green.
  const overriddenDeps = (viewer.extraMetadata as { readonly dependencies?: unknown } | undefined)
    ?.dependencies
  if (overriddenDeps === undefined || overriddenDeps === null) {
    violations.push(
      '`extraMetadata.dependencies` is missing — without it the product inherits `@camstack/server` and bundles the whole closure into app.asar',
    )
  } else if (typeof overriddenDeps !== 'object') {
    violations.push('`extraMetadata.dependencies` is not an object')
  } else if ('@camstack/server' in (overriddenDeps as Record<string, unknown>)) {
    violations.push(
      '`extraMetadata.dependencies` still lists `@camstack/server` — that is the closure, bundled by npm rather than staged',
    )
  }

  // Both products, not just the viewer. The FAT build stages the closure into
  // `Resources/node_modules` on purpose (the starter loads it from there) — and
  // was ALSO bundling it into `app.asar`, for the same reason the viewer was:
  // `@camstack/server` is a declared dependency and electron-builder packs
  // production dependencies whether or not anything imports them. Measured
  // 2026-09-09: the hub product's asar was 362 MB and became 3.6 MB once its
  // `files` denied node_modules. Nothing in `dist/` requires anything from
  // there but `electron-store` and `electron-updater`.
  const fatFiles = (pkg.build as { readonly files?: unknown } | undefined)?.files
  if (!Array.isArray(fatFiles)) {
    violations.push(
      'the fat product declares no `build.files` — it will bundle the whole closure into app.asar',
    )
  } else if (!fatFiles.includes('!node_modules/**')) {
    violations.push(
      "the fat product's `build.files` does not deny `node_modules/**` — the closure is staged into Resources AND bundled into app.asar (362 MB, measured)",
    )
  }

  // The release workflow reads the build output by PATH, and the two products
  // do not share one: the fat config writes `release/`, the viewer config
  // writes `release-viewer/` (it is also what `.gitignore` lists). Every step
  // that touches an installer — the mac notarize loop, the dispatch listing,
  // the tag-push staging — used a hard-coded `release/`, so the viewer legs
  // built their DMG and then failed to find it. Caught 2026-09-09, before the
  // first viewer release ran. The matrix now carries `output_dir` per leg;
  // this asserts each leg's value against the config it actually builds with,
  // so a config that changes its output directory cannot leave the workflow
  // pointing at the old one.
  const workflow = fs.existsSync(RELEASE_WORKFLOW)
    ? fs.readFileSync(RELEASE_WORKFLOW, 'utf8')
    : null
  if (workflow === null) {
    violations.push('.github/workflows/release.yml is gone; the release legs cannot be checked')
  } else {
    const legs = workflow.match(/\{target:"desktop[^\n]*?\}/g) ?? []
    if (legs.length === 0) {
      violations.push('release.yml declares no desktop legs — the matrix shape changed')
    }
    const viewerOutput = (viewer as { readonly directories?: { readonly output?: unknown } })
      .directories?.output
    const fatOutput =
      (pkg.build as { readonly directories?: { readonly output?: unknown } } | undefined)
        ?.directories?.output ?? 'release'
    for (const leg of legs) {
      const target = /target:"([^"]+)"/.exec(leg)?.[1] ?? '?'
      const declared = /output_dir:"([^"]+)"/.exec(leg)?.[1]
      const expected = target === 'desktop-viewer' ? viewerOutput : fatOutput
      if (declared === undefined) {
        violations.push(
          `release.yml leg \`${target}\` declares no \`output_dir\` — the workflow would read a hard-coded path`,
        )
      } else if (declared !== expected) {
        violations.push(
          `release.yml leg \`${target}\` reads \`${declared}\` but its config writes \`${String(expected)}\``,
        )
      }
    }
    for (const hard of workflow.matchAll(/matrix\.workspace \}\}\/release\//g)) {
      violations.push(
        `release.yml still reads a hard-coded \`release/\` at offset ${hard.index} — use \`matrix.output_dir\``,
      )
    }
  }

  // A mac leg is NOTARIZED by the workflow, and Apple will not notarize what is
  // not signed. The viewer config shipped with `identity: null`,
  // `hardenedRuntime: false` and no entitlements — deliberate when it was
  // written, so a local build needed no certificate, and wrong the moment it
  // reached the release runner: the DMG built, the notary service answered
  // `status: Invalid`, and the leg failed three attempts deep on 2026-09-09
  // (submission b9d00fe1). That is also a worse outcome than the workflow
  // failing, because an unsigned DMG that DID ship is one Gatekeeper refuses
  // to open on the operator's machine.
  //
  // The rule: the reduced product signs exactly like the fat one. It may
  // differ in what it CONTAINS — that is the whole point of it — but not in
  // whether macOS will run it.
  const viewerMac = (viewer as { readonly mac?: Record<string, unknown> }).mac ?? {}
  const fatMac = (pkg.build as { readonly mac?: Record<string, unknown> } | undefined)?.mac ?? {}
  if ('identity' in viewerMac && viewerMac['identity'] === null) {
    violations.push(
      '`mac.identity` is null — the product is unsigned, and the release workflow will submit it to Apple, which answers `Invalid`',
    )
  }
  for (const key of ['hardenedRuntime', 'entitlements', 'entitlementsInherit'] as const) {
    if (fatMac[key] !== undefined && viewerMac[key] !== fatMac[key]) {
      violations.push(
        `\`mac.${key}\` is ${JSON.stringify(viewerMac[key])} but the fat product ships ${JSON.stringify(fatMac[key])} — the two products differ in what they CONTAIN, never in whether macOS will run them`,
      )
    }
  }

  for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('dist:viewer')) continue
    if (body.includes('stage-deps')) {
      violations.push(
        `\`${name}\` runs stage-deps — that step installs the closure the guard exists to keep out`,
      )
    }
  }

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '  \x1b[32m✔\x1b[0m  viewer build carries no server closure, owns its artifact name, and every release leg reads the directory its config writes',
    )
    return
  }

  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ viewer-build guard failed\x1b[0m')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`    - ${v}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
