#!/usr/bin/env tsx
/**
 * One device-link surface: the `SourceSelector`.
 *
 * Customize's device-link dialog `CustomizeDevicePickerDialog` was a second device picker next to
 * the `SourceSelector` (its own chips, suggestions and confirm). It was deleted and every caller
 * moved to `SourceSelector kind="devices"` / `SourceSelectorDevicesDialog`. This guard refuses
 * the name anywhere in package sources (a spec beside its file included), so the second picker does not come back.
 *
 * Usage: npx tsx scripts/check-no-customize-device-picker-dialog.ts
 */
import path from 'node:path'
import {
  isMain,
  ROOT,
  readSources,
  report,
  type SourceFile,
  type Violation,
  walk,
} from './lib/family-baseline.js'

const SCANNED = 'packages'
const BANNED = /\bCustomizeDevicePickerDialog\b/
const SOURCE_RE = /\.(?:ts|tsx)$/
const SELF = 'scripts/check-no-customize-device-picker-dialog.ts'

export function findViolations(sources: readonly SourceFile[]): Violation[] {
  return sources
    .filter((file) => file.path !== SELF && BANNED.test(file.text))
    .map((file) => ({
      where: file.path,
      message:
        'names CustomizeDevicePickerDialog, the deleted second device picker. Use SourceSelector kind="devices" (SourceSelectorDevicesDialog in components/device/customize/source-selector/)',
    }))
}

function main(): number {
  const files = walk(path.join(ROOT, SCANNED), (p: string) => SOURCE_RE.test(p))
  return report('check-no-customize-device-picker-dialog', findViolations(readSources(files)))
}

if (isMain(import.meta.url)) process.exit(main())
