#!/usr/bin/env tsx
/**
 * Integration-hub link guard — **`lib/integration-hub-url.ts` is the only place
 * a link into an integration page is spelled.**
 *
 * ## The failure this catches
 *
 * Every page built on `<IntegrationHub>` reads `?integration=<addonId>` and
 * `?section=<id>` (D774). A link that spells the query itself — a raw
 * `"/system/network?tab=remote-access&integration=…"` in a component, a
 * notification or a docs-driven redirect — keeps working until the day a
 * parameter or a hosting tab is renamed, and then opens the default
 * integration with no error anywhere: the operator reads Alexa's settings under
 * a link that promised HomeKit's. The builder (`integrationHubHref`) is the one
 * spelling, and the page registry it reads is checked against what actually
 * routes.
 *
 * ## What it checks
 *
 *  1. No source file under `packages/addon-admin-ui/src` other than the builder
 *     contains a string or template literal with `integration=` or `section=`.
 *  2. Every page in `INTEGRATION_HUB_PAGES` names a path `App.tsx` routes.
 *  3. Every page with a `tab` names a hosting `AdminTabs` entry, and that entry
 *     takes its id FROM the registry (`id: INTEGRATION_HUB_PAGES.<page>.tab`)
 *     and drops the hub's params when left (`ownedParams:
 *     INTEGRATION_HUB_OWNED_PARAMS`).
 *
 * Specs are exempt — they assert on URLs by design.
 *
 * Usage: tsx scripts/check-integration-hub-links.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { INTEGRATION_HUB_PAGES } from '../packages/addon-admin-ui/src/lib/integration-hub-url'

const ROOT = path.resolve(import.meta.dirname, '..')
const ADMIN_SRC = path.join(ROOT, 'packages/addon-admin-ui/src')
const BUILDER = 'packages/addon-admin-ui/src/lib/integration-hub-url.ts'
const APP = path.join(ADMIN_SRC, 'App.tsx')

/** The hosting page file for each `/system/*` path that carries an AdminTabs strip. */
const HOST_FILES: Readonly<Record<string, string>> = {
  '/system/network': 'pages/system/Network.tsx',
  '/system/identity': 'pages/system/Identity.tsx',
  '/system/logs': 'pages/system/Logs.tsx',
}

/** A quoted or template literal that spells one of the hub's params. */
const SPELLED_PARAM = /(['"`])[^'"`\n]*[?&](integration|section)=/

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      out.push(full)
    }
  }
}

function main(): void {
  const problems: string[] = []

  const files: string[] = []
  walk(ADMIN_SRC, files)
  for (const file of files) {
    if (rel(file) === BUILDER) continue
    fs.readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return
        if (SPELLED_PARAM.test(line)) {
          problems.push(
            `${rel(file)}:${i + 1} spells an integration-hub param — use integrationHubHref()`,
          )
        }
      })
  }

  const app = fs.readFileSync(APP, 'utf-8')
  for (const [page, { path: route, tab }] of Object.entries(INTEGRATION_HUB_PAGES)) {
    if (!app.includes(`path="${route}"`)) {
      problems.push(`INTEGRATION_HUB_PAGES.${page}: App.tsx routes no "${route}"`)
    }
    if (tab === null) continue
    const host = HOST_FILES[route]
    if (host === undefined) {
      problems.push(
        `INTEGRATION_HUB_PAGES.${page}: no hosting page known for "${route}" — add it to HOST_FILES`,
      )
      continue
    }
    const source = fs.readFileSync(path.join(ADMIN_SRC, host), 'utf-8')
    if (!source.includes(`id: INTEGRATION_HUB_PAGES.${page}.tab`)) {
      problems.push(
        `${host}: the "${tab}" tab must take its id from INTEGRATION_HUB_PAGES.${page}.tab`,
      )
    }
    const owned = source.split(`id: INTEGRATION_HUB_PAGES.${page}.tab`)[1]?.split('}')[0] ?? ''
    if (!owned.includes('ownedParams: INTEGRATION_HUB_OWNED_PARAMS')) {
      problems.push(
        `${host}: the "${tab}" tab must declare ownedParams: INTEGRATION_HUB_OWNED_PARAMS`,
      )
    }
  }

  if (problems.length > 0) {
    console.error(`check-integration-hub-links: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(
    `check-integration-hub-links: OK (${files.length} files, ${Object.keys(INTEGRATION_HUB_PAGES).length} pages)`,
  )
}

main()
