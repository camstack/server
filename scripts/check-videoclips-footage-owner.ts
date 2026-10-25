#!/usr/bin/env tsx
/**
 * A clip source over RECORDED FOOTAGE is declared by the addon that owns the
 * footage (D560).
 *
 * ## The failure this catches
 *
 * `videoclips` shipped registered by `pipeline-analytics`, because the visit
 * composer needs the analytics event log. But a clip from that source is a time
 * WINDOW over the recorder's segments — `getClipPlayback` resolves through
 * `recording.getPlaybackManifest` and nothing else — so the addon serving it
 * held one half of the answer and borrowed the other. Operator, 2026-09-20:
 * *"deve registrarla CHI ha il footage e non altri addons casuali"* [it must be registered BY WHOEVER has the footage and not by other random addons].
 *
 * It is not a naming preference. Ownership decides where the failure surfaces:
 * the half that is REMOTE is the half that can be unreachable, and the source's
 * degradation vocabulary has to be written for that half. Put the registration
 * on the wrong addon and "the footage is gone" and "the annotations are gone"
 * swap places, silently.
 *
 * ## What it checks
 *
 * For every workspace package: if any of its addon manifest entries declares
 * the `videoclips` capability AND the package's sources resolve clip playback
 * through `recording.getPlaybackManifest`, then the SAME entry must also
 * declare `recording`. One addon, one archive.
 *
 * A package that declares `videoclips` and never touches the recorder's
 * playback is a NATIVE catalog (the camera's own SD card, HomeKit) and is not
 * that rule's business — it owns its footage by holding it.
 *
 * And, for every declarer: the package must actually REGISTER a provider for
 * the capability (`videoclipsCapability` appears in its sources). A declaration
 * with nothing behind it is not inert — `getBindings` derives a collection
 * cap's sources from the DECLARERS (D554 amended), so the camera gains a source
 * the dispatcher then cannot resolve, and the picker gains a row that answers
 * nothing.
 *
 * Usage: tsx scripts/check-videoclips-footage-owner.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages')
const VIDEOCLIPS_CAP = 'videoclips'
const RECORDING_CAP = 'recording'
/** The call that makes a source a view over the RECORDER's archive. */
const RECORDER_PLAYBACK_CALL = 'recording.getPlaybackManifest'
/** The symbol a provider registration names. */
const VIDEOCLIPS_CAP_SYMBOL = 'videoclipsCapability'

interface ManifestCapability {
  readonly name?: unknown
}
interface ManifestAddonEntry {
  readonly id?: unknown
  readonly capabilities?: unknown
}

function capNames(entry: ManifestAddonEntry): readonly string[] {
  const caps = entry.capabilities
  if (!Array.isArray(caps)) return []
  const names: string[] = []
  for (const cap of caps) {
    if (typeof cap === 'string') names.push(cap)
    else if (cap !== null && typeof cap === 'object') {
      const name = (cap as ManifestCapability).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

function addonEntries(manifestPath: string): readonly ManifestAddonEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const addons = (raw as { camstack?: { addons?: unknown } }).camstack?.addons
  return Array.isArray(addons) ? (addons as readonly ManifestAddonEntry[]) : []
}

/** Does any non-test source file under `dir` contain `needle`? */
function sourcesMention(dir: string, needle: string): boolean {
  if (!fs.existsSync(dir)) return false
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, child.name)
    if (child.isDirectory()) {
      if (child.name === 'node_modules' || child.name === '__tests__') continue
      if (sourcesMention(full, needle)) return true
      continue
    }
    if (!child.name.endsWith('.ts') && !child.name.endsWith('.tsx')) continue
    if (fs.readFileSync(full, 'utf8').includes(needle)) return true
  }
  return false
}

function main(): void {
  const failures: string[] = []
  let checked = 0

  for (const pkg of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const manifestPath = path.join(PACKAGES_DIR, pkg.name, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const entries = addonEntries(manifestPath)
    const declaring = entries.filter((e) => capNames(e).includes(VIDEOCLIPS_CAP))
    if (declaring.length === 0) continue
    const src = path.join(PACKAGES_DIR, pkg.name, 'src')
    const registers = sourcesMention(src, VIDEOCLIPS_CAP_SYMBOL)
    const composesFootage = sourcesMention(src, RECORDER_PLAYBACK_CALL)

    for (const entry of declaring) {
      checked += 1
      const id = typeof entry.id === 'string' ? entry.id : '(unnamed entry)'
      if (!registers) {
        failures.push(
          `packages/${pkg.name} — addon "${id}" declares "${VIDEOCLIPS_CAP}" but nothing in its ` +
            `sources registers a provider for it (no \`${VIDEOCLIPS_CAP_SYMBOL}\`). A collection ` +
            `cap's sources are derived from its DECLARERS, so this gives every camera a source ` +
            `the dispatcher cannot resolve and a picker row that answers nothing (D554, D560).`,
        )
      }
      if (composesFootage && !capNames(entry).includes(RECORDING_CAP)) {
        failures.push(
          `packages/${pkg.name} — addon "${id}" declares "${VIDEOCLIPS_CAP}" and resolves clip ` +
            `playback through \`${RECORDER_PLAYBACK_CALL}\`, but does not declare "${RECORDING_CAP}". ` +
            `A clip from that source IS a window over the recorder's segments; the addon that owns ` +
            `the footage is the one that declares the source (D560).`,
        )
      }
    }
  }

  if (failures.length > 0) {
    console.error('\n✖ videoclips footage-owner guard failed\n')
    for (const failure of failures) console.error(`  - ${failure}\n`)
    process.exit(1)
  }
  console.log(
    `✔ videoclips footage-owner guard passed (${String(checked)} declared clip source(s))`,
  )
}

main()
