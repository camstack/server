#!/usr/bin/env tsx
/**
 * Onboarding-manifest guard (D1077).
 *
 * ## The failure this catches
 *
 * The get-started flow is written once, in the public docs, and `dominevo mcp`
 * bundles a snapshot of the manifest the docs build emits. The manifest names
 * things that live HERE: admin UI routes and sidebar labels for the manual
 * path, and the addon ids and packages of the core addon groups. Rename a
 * route, a label or a package here and the docs — and every assistant reading
 * them — keep sending people to a place that no longer exists. Nothing else
 * notices: the docs repository cannot see this one.
 *
 * ## What it checks
 *
 * 1. every `ui.route` is a route the admin UI mounts or an addon page declares;
 * 2. every `ui.nav` label is an English string of the admin UI;
 * 3. every core addon `{ id, package }` is an addon a workspace package declares;
 * 4. when a docs checkout is present (`CAMSTACK_DOCS_DIR`, else `docs` beside the
 *    main checkout), the bundled snapshot is the same document as its manifest;
 * 5. with `--live`, the snapshot is not ahead of, nor a different document than,
 *    the one the docs site serves. Network: never part of an automatic gate.
 *
 * That the manifest's TOOLS exist is the CLI's own spec
 * (`packages/cli/src/__tests__/onboarding-manifest.spec.ts`).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OnboardingManifestSchema } from '../packages/cli/src/onboarding/manifest-schema.ts'
import {
  compareSnapshot,
  liveProblems,
  manifestProblems,
  type RepositoryFacts,
} from './onboarding-manifest-check.ts'
import { DOCS_MANIFEST_RELATIVE, SNAPSHOT_PATH, docsCheckout } from './onboarding-manifest-paths.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE_URL = 'https://camstack-docs.zentik.app/onboarding/v1/manifest.json'

const PackageSchema = z.object({
  name: z.string(),
  camstack: z
    .object({
      addons: z
        .array(
          z.object({
            id: z.string(),
            pages: z.array(z.object({ path: z.string() })).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})
type WorkspacePackage = z.infer<typeof PackageSchema>

function workspacePackages(): readonly WorkspacePackage[] {
  const dir = join(ROOT, 'packages')
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name, 'package.json')
    if (!existsSync(file)) return []
    const parsed = PackageSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? [parsed.data] : []
  })
}

function stringValues(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringValues)
  return []
}

function repositoryFacts(): RepositoryFacts {
  const packages = workspacePackages()
  const app = readFileSync(join(ROOT, 'packages/addon-admin-ui/src/App.tsx'), 'utf8')
  const mounted = [...app.matchAll(/path="([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []))
  const addons = packages.flatMap((pkg) =>
    (pkg.camstack?.addons ?? []).map((addon) => ({
      ...addon,
      packageName: pkg.name,
    })),
  )
  const pages = addons.flatMap((addon) => (addon.pages ?? []).map((page) => page.path))
  const catalogue: unknown = JSON.parse(
    readFileSync(join(ROOT, 'packages/addon-admin-ui/src/i18n/en.json'), 'utf8'),
  )
  return {
    routes: new Set([...mounted, ...pages]),
    labels: new Set(stringValues(catalogue)),
    addonPackages: new Map(addons.map((addon) => [addon.id, addon.packageName])),
  }
}

async function main(): Promise<void> {
  const bundledText = readFileSync(SNAPSHOT_PATH, 'utf8')
  const manifest = OnboardingManifestSchema.parse(JSON.parse(bundledText))
  const problems: string[] = [...manifestProblems(manifest, repositoryFacts())]

  const docs = docsCheckout()
  if (docs === null) {
    process.stdout.write(
      'check-onboarding-manifest: no docs checkout (CAMSTACK_DOCS_DIR unset, no sibling `docs`) — snapshot not compared.\n',
    )
  } else {
    const file = join(docs, DOCS_MANIFEST_RELATIVE)
    if (!existsSync(file)) problems.push(`${file} does not exist`)
    else {
      const verdict = compareSnapshot(bundledText, readFileSync(file, 'utf8'))
      if (verdict.kind === 'differs') problems.push(verdict.detail)
    }
  }

  if (process.argv.includes('--live')) {
    const response = await fetch(LIVE_URL)
    if (!response.ok) problems.push(`${LIVE_URL} answered ${response.status}`)
    else {
      const live = OnboardingManifestSchema.parse(await response.json())
      problems.push(...liveProblems(manifest, live))
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `check-onboarding-manifest: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  process.stdout.write(
    `check-onboarding-manifest: OK — revision ${manifest.revision} (${manifest.contentHash}).\n`,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `check-onboarding-manifest: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
