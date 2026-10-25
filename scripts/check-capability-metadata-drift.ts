#!/usr/bin/env tsx
/**
 * D4 codegen guard — fail the build if any addon `package.json` manifest
 * declares behavioural capability metadata (`kind` / `defaultActive`).
 * That metadata is owned exclusively by the `.cap.ts` definition.
 *
 * Usage: npx tsx scripts/check-capability-metadata-drift.ts
 */
import * as path from 'node:path'
import {
  findAddonPackageJsonFiles,
  findManifestMetadataDrift,
} from './capability-metadata-drift.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

const drift = findManifestMetadataDrift(findAddonPackageJsonFiles(ROOT))

if (drift.length === 0) {
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m capability-metadata guard passed')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\n\x1b[31m✘ capability metadata drift detected:\x1b[0m')
// eslint-disable-next-line no-console
console.error('  Addon package.json manifests must declare only WHICH caps an addon provides.')
// eslint-disable-next-line no-console
console.error('  `kind` / `defaultActive` belong ONLY on the *.cap.ts CapabilityDefinition (D4).\n')
for (const d of drift) {
  // eslint-disable-next-line no-console
  console.error(
    `    - ${path.relative(ROOT, d.file)} → addon '${d.addonId}' cap '${d.capName}': remove ${d.offendingKeys.join(', ')}`,
  )
}
// eslint-disable-next-line no-console
console.error('')
process.exit(1)
