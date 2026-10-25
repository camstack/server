#!/usr/bin/env tsx
/**
 * The committed UI catalogue (`docs/reference/ui-components.json`) is what the
 * sources produce: ui-library exports and props, the need table, the colour
 * tokens and — when the `camstack/` submodule is checked out — the viewer kit.
 *
 * Agents search this file (`npm run ui:find`, the `camstack-dev` UI tools)
 * instead of reading the library, so a stale one sends them to a component
 * that was renamed or hides one that was added. The pre-commit hook
 * regenerates it; this guard covers a commit that bypassed the hook.
 *
 * Without the submodule the viewer section cannot be re-read: the guard says
 * so on stdout and compares everything else.
 */
import * as path from 'node:path'
import { catalogueDrift } from './ui/lib/ui-catalogue.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function main(): void {
  const drift = catalogueDrift(ROOT)
  if (drift.stale) {
    console.error(`✘ check-ui-catalogue-current: ${drift.message}`)
    process.exit(1)
  }
  console.log(`✔ check-ui-catalogue-current: ${drift.message}`)
}

main()
