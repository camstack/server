#!/usr/bin/env tsx
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- TECH-DEBT(test-2026-03-31): test/script file */
/**
 * Verify that every @camstack/* import in each package is declared
 * as a dependency (dependencies, peerDependencies, or devDependencies).
 *
 * Usage:
 *   npx tsx scripts/check-deps.ts          # check only
 *   npx tsx scripts/check-deps.ts --fix    # auto-add missing deps
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const FIX = process.argv.includes('--fix')

interface Issue {
  package: string
  dir: string
  missing: string
  files: string[]
}

/**
 * Package aliases that are not real npm packages.
 * `@camstack/owner-only-file` is the desktop shell's tsconfig/tsup/vitest alias
 * for ONE source file of @camstack/types (`src/util/owner-only-file.ts`), which
 * tsup bundles (`noExternal`) — declaring it as a dependency would name a
 * package that does not exist.
 */
const ALIASES = new Set(['@camstack/ui', '@camstack/owner-only-file'])

function findTsFiles(dir: string): string[] {
  const result: string[] = []
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Skip generated code: codegen output (e.g. the aggregated AppRouter type in
    // `types/src/generated/addon-api.ts`) legitimately references types across the
    // whole package graph. Those imports are not hand-authored dependency choices
    // — any genuine runtime dep also appears in a hand-written source file — so
    // declaring deps from generated files would force false cross-package cycles.
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '__tests__' ||
      entry.name === 'generated'
    )
      continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...findTsFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(full)
    }
  }
  return result
}

/**
 * The `@camstack/*` packages a file really imports: import/export declarations,
 * dynamic `import()` and `require()`. Parsed with the TypeScript compiler, not
 * matched line by line — a scaffold that EMITS `import … from '@camstack/types'`
 * inside a template string (packages/develop) is text, not a dependency.
 */
function extractCamstackImports(file: string): Set<string> {
  const content = fs.readFileSync(file, 'utf-8')
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false)
  const imports = new Set<string>()
  const record = (specifier: string): void => {
    const match = /^(@camstack\/[a-z][a-z0-9-]*)(?:\/.*)?$/.exec(specifier)
    if (match) imports.add(match[1]!)
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const ref = node.moduleReference.expression
      if (ts.isStringLiteral(ref)) record(ref.text)
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && arg !== undefined && ts.isStringLiteralLike(arg)) {
        record(arg.text)
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) record(arg.literal.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return imports
}

function getDeclaredDeps(pkgJson: any): Set<string> {
  const deps = new Set<string>()
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    if (pkgJson[section]) {
      for (const name of Object.keys(pkgJson[section])) {
        deps.add(name)
      }
    }
  }
  return deps
}

// Scan all packages
const packagesDir = path.join(ROOT, 'packages')
const serverDir = path.join(ROOT, 'server', 'backend')

const packageDirs: Array<{ name: string; dir: string; pkgJsonPath: string }> = []

// packages/*
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) continue
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
  packageDirs.push({ name: pkgJson.name, dir: path.join(packagesDir, entry.name), pkgJsonPath })
}

// server/backend
if (fs.existsSync(path.join(serverDir, 'package.json'))) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf-8'))
  packageDirs.push({
    name: pkgJson.name,
    dir: serverDir,
    pkgJsonPath: path.join(serverDir, 'package.json'),
  })
}

const issues: Issue[] = []

for (const { name, dir, pkgJsonPath } of packageDirs) {
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
  const declared = getDeclaredDeps(pkgJson)
  const srcDir = path.join(dir, 'src')

  const tsFiles = findTsFiles(srcDir)
  const allImports = new Map<string, string[]>()

  for (const file of tsFiles) {
    const imports = extractCamstackImports(file)
    for (const imp of imports) {
      if (imp === name) continue // self-import
      if (!allImports.has(imp)) allImports.set(imp, [])
      allImports.get(imp)!.push(path.relative(dir, file))
    }
  }

  for (const [imp, files] of allImports) {
    if (ALIASES.has(imp)) continue
    if (!declared.has(imp)) {
      issues.push({ package: name, dir, missing: imp, files })
    }
  }
}

if (issues.length === 0) {
  console.log('✓ All @camstack/* imports have matching dependencies')
  process.exit(0)
}

console.log(`Found ${issues.length} missing dependency declaration(s):\n`)

for (const issue of issues) {
  console.log(`  ${issue.package} → missing "${issue.missing}"`)
  for (const f of issue.files.slice(0, 3)) {
    console.log(`    ${f}`)
  }
  if (issue.files.length > 3) {
    console.log(`    ... and ${issue.files.length - 3} more`)
  }
}

if (FIX) {
  console.log('\nApplying fixes...')

  // Group by package
  const byPackage = new Map<string, Issue[]>()
  for (const issue of issues) {
    const key = issue.dir
    if (!byPackage.has(key)) byPackage.set(key, [])
    byPackage.get(key)!.push(issue)
  }

  for (const [dir, pkgIssues] of byPackage) {
    const pkgJsonPath = path.join(dir, 'package.json')
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))

    for (const issue of pkgIssues) {
      // Add as peerDependency + devDependency (standard pattern for workspace packages)
      if (!pkgJson.peerDependencies) pkgJson.peerDependencies = {}
      if (!pkgJson.devDependencies) pkgJson.devDependencies = {}

      if (!pkgJson.dependencies?.[issue.missing] && !pkgJson.peerDependencies[issue.missing]) {
        pkgJson.peerDependencies[issue.missing] = '^0.1.0'
      }
      if (!pkgJson.devDependencies[issue.missing]) {
        pkgJson.devDependencies[issue.missing] = '*'
      }

      console.log(`  ✓ ${issue.package}: added "${issue.missing}" to peer+dev deps`)
    }

    // Sort dependency keys
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
      if (pkgJson[section]) {
        const sorted: Record<string, string> = {}
        for (const key of Object.keys(pkgJson[section]).sort()) {
          sorted[key] = pkgJson[section][key]
        }
        pkgJson[section] = sorted
      }
    }

    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n')
  }

  console.log('\nDone! Run `npm install` to update the lockfile.')
} else {
  console.log('\nRun with --fix to auto-add missing dependencies.')
  process.exit(1)
}
