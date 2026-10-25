/**
 * typecheck-split — one tsc pass, two verdicts: production code and specs.
 *
 * Every package with specs typechecks them through `tsconfig.spec.json` (the
 * package's own `tsconfig.json` plus the spec files it excludes from the
 * build), as ONE `tsc` program. A second program per package would check every
 * source file twice for the sake of the specs that import them; on the shared
 * CI runner that is minutes per run. So the pass is shared and the
 * diagnostics are split afterwards, by the file they are reported in:
 *
 *   - a spec/test file (`*.spec.*`, `*.test.*`, anything under `__tests__/`
 *     or `__mocks__/`) → the `typecheck-specs` bucket, keyed per file;
 *   - anything else → the `typecheck` bucket, keyed per package, exactly as
 *     before — production code stays held at zero on its own count, and a spec
 *     fixed elsewhere can never pay for a production error.
 */

export interface SectionSplit {
  /** Diagnostics in non-test files. */
  readonly production: number
  /** Diagnostics per test file, keyed by the path tsc printed (package-relative). */
  readonly specs: ReadonlyMap<string, number>
}

/** `path/to/file.ts(12,3): error TS2345: …` — what tsc prints without a TTY (CI). */
const FLAT_DIAGNOSTIC = /^(\S[^\n]*?)\(\d+,\d+\): error TS\d+:/gm
/** `path/to/file.ts:12:3 - error TS2345: …` — the pretty form, on a terminal. */
const PRETTY_DIAGNOSTIC = /^(\S[^\n]*?):\d+:\d+ - error TS\d+:/gm
const SUMMARY = /Found (\d+) errors?[ .]/

export function isSpecPath(file: string): boolean {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /(^|\/)__mocks__\//.test(file) ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(file)
  )
}

/**
 * Split one nx task section's tsc output. `null` when the section holds no
 * diagnostic and no summary — the caller decides whether that is "clean" or
 * "never reached tsc".
 *
 * When only a summary is readable (no per-file line), every error is counted
 * as PRODUCTION: unattributable errors must fail the stricter bucket, never
 * slip into the one that carries pinned debt.
 */
export function splitTypecheckSection(section: string): SectionSplit | null {
  const files: string[] = []
  for (const pattern of [FLAT_DIAGNOSTIC, PRETTY_DIAGNOSTIC]) {
    for (const match of section.matchAll(pattern)) {
      const file = match[1]
      if (file !== undefined) files.push(file)
    }
  }
  if (files.length === 0) {
    const summary = SUMMARY.exec(section)
    if (summary === null) return null
    return { production: Number(summary[1]), specs: new Map() }
  }
  let production = 0
  const specs = new Map<string, number>()
  for (const file of files) {
    if (isSpecPath(file)) specs.set(file, (specs.get(file) ?? 0) + 1)
    else production += 1
  }
  return { production, specs }
}
