/**
 * Pure rules of `scripts/check-migration-ports-surface.ts` (planning#447): a migration reaches the
 * world through `MigrationApiV1` and through nothing else.
 */

export interface SourceFile {
  readonly path: string
  readonly text: string
}

/** The one file that may call `defineAddonMigrations(` for a catalogue it runs (the seam itself). */
export const SEAM_FILE = 'packages/types/src/addon/base-addon.ts'

/** Imports a migration source may carry: the shared types package, zod and its own neighbours. */
function importAllowed(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier === 'zod' ||
    specifier === '@camstack/types' ||
    specifier.startsWith('@camstack/types/')
  )
}

/** Comments out of the way: a doc line that NAMES `ctx.api` is not a use of it. */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

export function isMigrationSource(file: string): boolean {
  return (
    (/^packages\/addon-[^/]+\/src\/(?:.*\/)?migrations\/.+\.ts$/.test(file) ||
      /^packages\/system\/src\/migrations\/hub\/.+\.ts$/.test(file)) &&
    !file.endsWith('.d.ts') &&
    !file.includes('/__tests__/') &&
    !file.includes('/__fixtures__/')
  )
}

function importSpecifiers(code: string): readonly string[] {
  const found: string[] = []
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  for (const match of code.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

/**
 * Rule 1: under a `migrations/` directory no `ctx.` / `this.ctx`, and only `@camstack/types`, zod and
 * local files are imported. Catalogue sources are an addon's `migrations/` and the hub's `src/migrations/hub/`;
 * the engine and the definition helpers are not migrations. Rule 2: `defineAddonMigrations(` is called only by the seam, except
 * from a file the shrink-only `pending` list names (a catalogue not moved onto the API yet).
 * A pending entry whose file no longer calls it is itself a problem: the list only ever shrinks.
 */
export function portsSurfaceProblems(
  files: readonly SourceFile[],
  pending: readonly string[],
): readonly string[] {
  const problems: string[] = []
  const callers = new Set<string>()
  for (const file of files) {
    const code = withoutComments(file.text)
    if (isMigrationSource(file.path)) {
      if (/\bctx\./.test(code) || /\bthis\.ctx\b/.test(code)) {
        problems.push(`${file.path}: a migration source reads \`ctx\`; take it from MigrationApiV1`)
      }
      for (const specifier of importSpecifiers(code)) {
        if (!importAllowed(specifier)) {
          problems.push(
            `${file.path}: imports '${specifier}'; a migration source imports @camstack/types, zod and local files only`,
          )
        }
      }
    }
    if (file.path !== SEAM_FILE && code.includes('defineAddonMigrations(')) {
      callers.add(file.path)
    }
  }
  const allowed = new Set(pending)
  for (const caller of [...callers].toSorted()) {
    if (!allowed.has(caller)) {
      problems.push(
        `${caller}: binds ports itself with defineAddonMigrations(); use this.runMigrations(CATALOGUE, (api) => ports)`,
      )
    }
  }
  for (const entry of [...allowed].toSorted()) {
    if (!callers.has(entry)) {
      problems.push(
        `scripts/migration-ports-surface-pending.json: '${entry}' is moved onto the API (or gone); delete the entry`,
      )
    }
  }
  return problems
}
