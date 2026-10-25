#!/usr/bin/env tsx
// emit-isolated-dts — per-file declaration emit via oxc-transform (no TS program).
// Used by packages that have cleared isolatedDeclarations debt (P3,
// docs/design/2026-10-09-ts7-transition-plan.md). Walks src TypeScript files,
// skips tests, writes mirrors under outDir preserving the relative path.
// Usage: tsx scripts/emit-isolated-dts.ts --root <pkg> --src src --out dist
import * as fs from 'node:fs'
import * as path from 'node:path'

import { isolatedDeclarationSync } from 'oxc-transform'

interface Args {
  readonly root: string
  readonly src: string
  readonly out: string
}

function parseArgs(argv: readonly string[]): Args {
  let root = process.cwd()
  let src = 'src'
  let out = 'dist'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--root' && next) {
      root = path.resolve(next)
      i++
    } else if (a === '--src' && next) {
      src = next
      i++
    } else if (a === '--out' && next) {
      out = next
      i++
    }
  }
  return { root, src, out }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue
      out.push(...walk(full))
      continue
    }
    if (!/\.tsx?$/.test(ent.name)) continue
    if (/\.(test|spec)\.tsx?$/.test(ent.name)) continue
    out.push(full)
  }
  return out
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const srcRoot = path.join(args.root, args.src)
  const outRoot = path.join(args.root, args.out)
  if (!fs.existsSync(srcRoot)) {
    console.error(`emit-isolated-dts: missing src ${srcRoot}`)
    return 2
  }
  let files = 0
  let failed = 0
  for (const file of walk(srcRoot)) {
    const rel = path.relative(srcRoot, file)
    const sourceText = fs.readFileSync(file, 'utf8')
    const result = isolatedDeclarationSync(file, sourceText)
    if (result.errors.length > 0) {
      failed++
      for (const err of result.errors) {
        console.error(`${rel}: ${err.message}`)
      }
      continue
    }
    const outFile = path.join(outRoot, rel.replace(/\.tsx?$/, '.d.ts'))
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, result.code)
    files++
  }
  if (failed > 0) {
    console.error(`emit-isolated-dts: ${failed} file(s) failed`)
    return 1
  }
  console.log(`emit-isolated-dts: wrote ${files} declaration(s) under ${args.out}`)
  return 0
}

process.exit(main())
