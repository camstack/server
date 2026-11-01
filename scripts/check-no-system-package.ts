#!/usr/bin/env tsx
/**
 * The old system package is gone: its source ships as `@camstack/server/system`.
 *
 * The kernel and the builtins are a private workspace (`@camstack/server-framework`)
 * whose built output ships INSIDE the `@camstack/server` tarball, imported as
 * `@camstack/server/system` (D989). One published framework package means one version to
 * keep in step, and no `force_packages=@camstack/system` on a capability change.
 *
 * A source or config file that still names `@camstack/system` imports a package
 * that is no longer published: it resolves from a stale copy under a node's
 * data dir, or not at all. There is no alias and no shim — the old name is a
 * bug, not a spelling.
 *
 * Allowed: history (ADRs, changelogs, release notes, dated design notes,
 * benchmarks), the lockfile, the patch record, and the few files whose job is
 * to recognise the old name on a node that still carries it
 * (`legacy-package-names.ts` and what reads it).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Not preceded by a path/name character and not followed by `-` or a word character. */
const OLD_NAME = /(?<![\w/-])@camstack\/system(?![\w-])/

export const ALLOWED: readonly RegExp[] = [
  /^docs\/decisions\//,
  /^docs\/design\//,
  /^docs\/benchmarks\//,
  /(^|\/)CHANGELOG\.md$/,
  /^changelog\//,
  /^releases?\//,
  /^patches\//,
  /(^|\/)assets\/viewer\//,
  /(^|\/)package-lock\.json$/,
  /^server\/backend\/src\/legacy-package-names\.ts$/,
  /^packages\/system\/src\/kernel\/(__tests__\/)?addon-residue(\.spec)?\.ts$/,
  /^packages\/system\/src\/kernel\/__tests__\/addon-manifest\.spec\.ts$/,
  /^server\/backend\/src\/__tests__\/(addon-upload|package-inventory|single-copy-cleanup)\.spec\.ts$/,
  /^packages\/node-root\/src\/__tests__\/starter-core\.spec\.ts$/,
  /^scripts\/check-npm-orphan-packages\.ts$/,
  /^scripts\/check-no-system-package\.ts$/,
  /^scripts\/__tests__\/check-(no-system-package|host-externals-identical)\.spec\.ts$/,
]

export interface SystemPackageFinding {
  readonly file: string
  readonly line: number
}

export function findSystemPackageReferences(
  files: readonly { readonly rel: string; readonly content: string }[],
): readonly SystemPackageFinding[] {
  const findings: SystemPackageFinding[] = []
  for (const f of files) {
    if (ALLOWED.some((re) => re.test(f.rel))) continue
    f.content.split('\n').forEach((text, i) => {
      if (OLD_NAME.test(text)) findings.push({ file: f.rel, line: i + 1 })
    })
  }
  return findings
}

const TEXT_FILE =
  /\.(ts|tsx|mts|mjs|cjs|js|json|md|mdc|yml|yaml|sh|toml|grit|css)$|(^|\/)Dockerfile[^/]*$/

function trackedFiles(): readonly string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 })
  return out
    .toString('utf-8')
    .split('\0')
    .filter((p) => p.length > 0 && TEXT_FILE.test(p))
}

function main(): void {
  const files = trackedFiles().flatMap((rel) => {
    try {
      return [{ rel, content: readFileSync(path.join(ROOT, rel), 'utf-8') }]
    } catch {
      return []
    }
  })
  const findings = findSystemPackageReferences(files)
  if (findings.length === 0) {
    console.log(`check-no-system-package: ${files.length} files, no \`@camstack/system\` specifier`)
    return
  }
  console.error(
    'check-no-system-package: `@camstack/system` is no longer a published package — import `@camstack/server/system`:',
  )
  for (const f of findings.slice(0, 60)) console.error(`  ${f.file}:${f.line}`)
  if (findings.length > 60) console.error(`  … and ${findings.length - 60} more`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
