#!/usr/bin/env tsx
/**
 * An engine that hosts a camera block never declares a camera row of its own
 * (D1057, planning#580).
 *
 * A Camera grid or a Terminal camera is a core block: the composer owns its row
 * `composed-<blockId>`, its name and its room, and the engine (the camera-grid
 * builtin, the Terminal addon) builds its device ON that row through
 * `loadContext` and serves the camera caps there. Before, each engine declared
 * its own rows: two lists, two naming paths, two delete paths, and a camera that
 * could outlive the thing it showed. Declaring a row again in an engine is how
 * that comes back, and it reads as ordinary code in review.
 *
 * Scope: runtime source of the engines in {@link ENGINE_ROOTS}, specs excluded.
 * Textual: any of {@link ROW_CREATORS} on a line is a finding. The legacy sweep
 * that REMOVES the old rows lives in `packages/types` and is out of scope.
 *
 * Usage: tsx scripts/check-engine-hosted-no-own-rows.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The engines that host engine-hosted helper kinds (`EngineHostedHelperSpec`). */
const ENGINE_ROOTS = ['packages/system/src/builtins/camera-grid/', 'packages/addon-terminal/src/']

/** Calls that create or declare a device row. */
const ROW_CREATORS = ['new DeclaredDevices(', 'devices.create(', 'allocateDeviceId('] as const

export interface SourceFile {
  readonly rel: string
  readonly content: string
}

export interface EngineRowFinding {
  readonly file: string
  readonly line: number
  readonly call: string
}

function isEngineRuntimeFile(rel: string): boolean {
  if (!ENGINE_ROOTS.some((root) => rel.startsWith(root))) return false
  return !rel.includes('/__tests__/') && !/\.(spec|test)\.tsx?$/.test(rel)
}

export function findEngineOwnedRows(files: readonly SourceFile[]): EngineRowFinding[] {
  const findings: EngineRowFinding[] = []
  for (const file of files) {
    if (!isEngineRuntimeFile(file.rel)) continue
    const lines = file.content.split('\n')
    lines.forEach((text, index) => {
      for (const call of ROW_CREATORS) {
        if (text.includes(call)) findings.push({ file: file.rel, line: index + 1, call })
      }
    })
  }
  return findings
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
}

function main(): void {
  const paths: string[] = []
  for (const root of ENGINE_ROOTS) walk(path.join(ROOT, root), paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findEngineOwnedRows(files)
  if (findings.length === 0) {
    console.log(
      `check-engine-hosted-no-own-rows: ${files.length} engine files, none declares a camera row of its own`,
    )
    return
  }
  console.error(
    'check-engine-hosted-no-own-rows: an engine hosting camera blocks declares a row of its own; host on the composer row through loadContext (D1057):',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.call}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
