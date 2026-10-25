/**
 * Binds the pure subsystem map (`subsystem-map.ts`) to THIS repository.
 *
 * It is its own file because two callers need the identical map and must not
 * build it two ways: `docs-generate.ts` renders it, `check-subsystem-map.ts`
 * guards it. A generated page that disagreed with the guard enforcing it would
 * be worse than either alone — the page would say a chapter is covered while CI
 * says it is orphaned, and nothing would report the contradiction.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isSourceFile, parseFrontmatter, repoFiles } from './docs-frontmatter.js'
import {
  buildSubsystemMap,
  type DocClaim,
  parseSubsystemsYaml,
  type SubsystemMap,
} from './subsystem-map.js'

/**
 * Working notes that used to live under archive and superpowers moved to the
 * sibling planning repo. They are not in this checkout, so they contribute no
 * coverage claims.
 */
function collectDocClaims(root: string, tracked: ReadonlySet<string>): readonly DocClaim[] {
  const claims: DocClaim[] = []
  for (const rel of [...tracked].toSorted()) {
    if (!rel.endsWith('.md')) continue
    if (!rel.startsWith('docs/') && path.basename(rel) !== 'AGENTS.md') continue
    if (path.basename(rel) === 'template.md') continue
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) continue
    const { fm } = parseFrontmatter(fs.readFileSync(abs, 'utf-8'))
    if (fm.appliesTo.length === 0 && fm.covers.length === 0) continue
    claims.push({
      doc: rel,
      appliesTo: fm.appliesTo,
      covers: fm.covers,
      lastVerified: fm.lastVerified,
    })
  }
  return claims
}

export function loadSubsystemMap(root: string, committedOnly: boolean): SubsystemMap {
  const tracked = repoFiles(root, committedOnly)
  const taxonomy = parseSubsystemsYaml(
    fs.readFileSync(path.join(root, 'docs', 'subsystems.yaml'), 'utf-8'),
  )
  return buildSubsystemMap({
    taxonomy,
    sourceFiles: [...tracked].filter((f) => isSourceFile(f)),
    docs: collectDocClaims(root, tracked),
    existingDocs: new Set([...tracked].filter((f) => f.endsWith('.md'))),
  })
}
