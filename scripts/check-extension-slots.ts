#!/usr/bin/env tsx
/**
 * GUARD: every extension slot is declared once, owned once, and served by an
 * addon that declares the contract (D648).
 *
 * `device-extension` is a contract over stores other addons already own. What
 * can go wrong is silent: a slot declared in a `*.cap.ts` that no addon
 * serves renders a card that never loads; two owners of one slot write two
 * stores for one question (D62); an owner whose manifest does not declare
 * `device-extension` never reaches the dispatcher; a contract method shaped
 * like `saveXConfig` turns the view into a second store. None of it fails a
 * type check. The rules themselves live in `extension-slots-guard.ts`, where
 * `scripts/__tests__/check-extension-slots.spec.ts` proves each red on a
 * fixture.
 *
 * Usage: tsx scripts/check-extension-slots.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EXTENSION_SLOTS_OUTPUT, REPO_ROOT, loadCapModules } from './extension-slots-load.ts'
import { collectExtensionSlots, renderExtensionSlotsModule } from './extension-slots-model.ts'
import { checkExtensionSlotFacts, type OwnerFact, type SlotFact } from './extension-slots-guard.ts'

const CONTRACT_CAP = 'device-extension'
/** `defineExtensionSlotProvider('<id>'` — the id literal, never a placeholder. */
const OWNER_CALL = /defineExtensionSlotProvider\(\s*'([a-z0-9][a-z0-9-]*)'/g
const SOURCE_ROOTS = ['packages', 'server']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) out.push(full)
  }
}

interface ManifestAddon {
  readonly id: string
  /** Repo-relative source directory the addon's entry is built from. */
  readonly srcDir: string
  readonly declaresContract: boolean
}

function manifestAddons(packageDir: string): readonly ManifestAddon[] {
  const pkgPath = path.join(REPO_ROOT, packageDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return []
  const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const camstack = isRecord(pkg) ? pkg['camstack'] : undefined
  const addons = isRecord(camstack) ? camstack['addons'] : undefined
  if (!Array.isArray(addons)) return []
  const out: ManifestAddon[] = []
  for (const addon of addons) {
    if (!isRecord(addon)) continue
    const id = addon['id']
    const entry = addon['entry']
    if (typeof id !== 'string' || typeof entry !== 'string') continue
    const srcEntry = entry.replace(/^\.\/dist\//, 'src/')
    const caps = Array.isArray(addon['capabilities']) ? addon['capabilities'] : []
    out.push({
      id,
      srcDir: path.join(packageDir, path.dirname(srcEntry)),
      declaresContract: caps.some((c) => isRecord(c) && c['name'] === CONTRACT_CAP),
    })
  }
  return out
}

function ownerFacts(): readonly OwnerFact[] {
  const files: string[] = []
  for (const root of SOURCE_ROOTS) {
    const rootDir = path.join(REPO_ROOT, root)
    for (const pkg of fs.readdirSync(rootDir, { withFileTypes: true })) {
      const src = path.join(rootDir, pkg.name, 'src')
      if (pkg.isDirectory() && fs.existsSync(src)) walk(src, files)
    }
  }
  const out: OwnerFact[] = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8')
    const rel = path.relative(REPO_ROOT, file)
    const packageDir = rel.split(path.sep).slice(0, 2).join('/')
    for (const match of text.matchAll(OWNER_CALL)) {
      const addon = manifestAddons(packageDir)
        .filter((a) => rel.startsWith(`${a.srcDir}/`))
        .toSorted((a, b) => b.srcDir.length - a.srcDir.length)[0]
      out.push({
        slotId: match[1] ?? '',
        file: rel,
        packageDir,
        addonId: addon?.id ?? null,
        addonDeclaresContract: addon?.declaresContract ?? false,
      })
    }
  }
  return out
}

async function main(): Promise<void> {
  const modules = await loadCapModules()
  const collected = collectExtensionSlots(modules)
  const slots: SlotFact[] = collected.map((s) => ({
    id: s.id,
    declaringCap: s.declaringCap,
    hasHostDeviceTypes: s.hostDeviceTypes !== null && s.hostDeviceTypes.length > 0,
    valueHasSlotKey: 'slot' in s.descriptor.value.shape,
  }))

  let generatedDrift: string | null = null
  try {
    const rendered = renderExtensionSlotsModule(collected)
    const onDisk = fs.existsSync(EXTENSION_SLOTS_OUTPUT)
      ? fs.readFileSync(EXTENSION_SLOTS_OUTPUT, 'utf-8')
      : ''
    if (rendered !== onDisk) {
      generatedDrift = `${path.relative(REPO_ROOT, EXTENSION_SLOTS_OUTPUT)} is stale — run \`npm run codegen\``
    }
  } catch (err: unknown) {
    generatedDrift = err instanceof Error ? err.message : String(err)
  }

  const contract = modules
    .flatMap((m) => Object.values(m.exports))
    .find((v) => isRecord(v) && v['name'] === CONTRACT_CAP && isRecord(v['methods']))
  const contractMethods =
    isRecord(contract) && isRecord(contract['methods']) ? Object.keys(contract['methods']) : []

  const owners = ownerFacts()
  const failures = [
    ...(contract === undefined
      ? [`no "${CONTRACT_CAP}" capability found — this guard has lost its subject`]
      : []),
    ...checkExtensionSlotFacts({ slots, owners, contractMethods, generatedDrift }),
  ]
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('check-extension-slots: FAILED\n')
    // eslint-disable-next-line no-console
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `check-extension-slots: OK — ${slots.length} slot(s): ` +
      slots
        .map(
          (s) =>
            `${s.id} (${s.declaringCap} → ${owners.find((o) => o.slotId === s.id)?.addonId ?? '?'})`,
        )
        .join(', '),
  )
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
