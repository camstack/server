import { describe, expect, it } from 'vitest'
import { claimGlobs, parseFrontmatter, stalenessGlobs } from '../lib/docs-frontmatter.js'
import {
  buildSubsystemMap,
  type DocClaim,
  findSubsystemProblems,
  parseSubsystemsYaml,
  renderCoveragePage,
  renderSubsystemsPage,
  type SubsystemEntry,
  type SubsystemMapInput,
} from '../lib/subsystem-map.js'

/**
 * The subsystem map is the one index in this repository built from a CURATED
 * input, so it is the one index that can be wrong in a way no compiler catches.
 * Every case below runs against a fixture tree, never the live repository: a
 * spec pinned to today's `docs/subsystems.yaml` would go red every time someone
 * adds a package, and would test the taxonomy instead of the join.
 *
 * The load-bearing case is "covers claims coverage and arms nothing" (D145). It
 * was written first and watched fail — `parseFrontmatter` ignored the key, so
 * `claimGlobs` came back empty. A fixture that pre-seeded the answer would have
 * hidden exactly the behaviour the decision record exists to create.
 */

const PIPELINE: SubsystemEntry = {
  id: 'pipeline',
  title: 'Pipeline',
  purpose: 'Turns a stream into frames.',
  ownerDoc: 'docs/architecture/pipeline.md',
  globs: ['packages/addon-pipeline/src/**'],
}

const CAPS: SubsystemEntry = {
  id: 'capabilities',
  title: 'Capability system',
  purpose: 'Declares what a node can do.',
  ownerDoc: 'docs/architecture/capabilities.md',
  globs: ['packages/types/src/capabilities/**'],
}

function input(patch: Partial<SubsystemMapInput> = {}): SubsystemMapInput {
  return {
    taxonomy: [PIPELINE, CAPS],
    sourceFiles: [
      'packages/addon-pipeline/src/runner.ts',
      'packages/addon-pipeline/src/decode.ts',
      'packages/types/src/capabilities/switch.cap.ts',
    ],
    docs: [],
    existingDocs: new Set([
      'docs/architecture/pipeline.md',
      'docs/architecture/capabilities.md',
      'docs/architecture/device-model.md',
    ]),
    ...patch,
  }
}

function doc(patch: Partial<DocClaim> = {}): DocClaim {
  return {
    doc: 'docs/architecture/pipeline.md',
    appliesTo: [],
    covers: [],
    lastVerified: null,
    ...patch,
  }
}

function view(map: ReturnType<typeof buildSubsystemMap>, id: string) {
  const found = map.subsystems.find((s) => s.entry.id === id)
  if (!found) throw new Error(`no subsystem ${id} in map`)
  return found
}

describe('frontmatter — two keys, two meanings (D145)', () => {
  it('reads `covers:` in block form and keeps it separate from `applies-to`', () => {
    const { fm } = parseFrontmatter(
      [
        '---',
        'title: x',
        'applies-to:',
        '  - a/**',
        'covers:',
        '  - b/**',
        '  - c/**',
        '---',
        '',
      ].join('\n'),
    )
    expect(fm.appliesTo).toEqual(['a/**'])
    expect(fm.covers).toEqual(['b/**', 'c/**'])
  })

  it('reads `covers:` in flow form', () => {
    const { fm } = parseFrontmatter(['---', 'covers: [a/**, b/**]', '---', ''].join('\n'))
    expect(fm.covers).toEqual(['a/**', 'b/**'])
  })

  /**
   * THE case. `covers:` buys a row in the coverage index and buys nothing in
   * the freshness ratchet. Collapsing the two is what makes a class-level page
   * permanently suspect and turns `--max-stale` from a signal into a floor.
   */
  it('`covers:` contributes coverage and contributes NO staleness globs', () => {
    const { fm } = parseFrontmatter(
      [
        '---',
        'covers:',
        '  - packages/addon-provider-*/**',
        'last-verified: 2026-08-14',
        '---',
      ].join('\n'),
    )
    expect(claimGlobs(fm)).toEqual(['packages/addon-provider-*/**'])
    expect(stalenessGlobs(fm)).toEqual([])
  })

  it('`applies-to:` contributes to BOTH', () => {
    const { fm } = parseFrontmatter(['---', 'applies-to:', '  - packages/x/**', '---'].join('\n'))
    expect(claimGlobs(fm)).toEqual(['packages/x/**'])
    expect(stalenessGlobs(fm)).toEqual(['packages/x/**'])
  })

  it('a doc using both keys claims the union and arms only `applies-to`', () => {
    const { fm } = parseFrontmatter(
      ['---', 'applies-to:', '  - a/**', 'covers:', '  - b/**', '---'].join('\n'),
    )
    expect([...claimGlobs(fm)].toSorted()).toEqual(['a/**', 'b/**'])
    expect(stalenessGlobs(fm)).toEqual(['a/**'])
  })
})

describe('taxonomy parsing', () => {
  const YAML = [
    '# a comment',
    '- id: pipeline',
    '  title: Pipeline — decode and detect',
    '  purpose: >',
    '    Turns a stream into frames,',
    '    then into detections.',
    '  owner-doc: docs/architecture/data-planes.md',
    '  globs:',
    '    - packages/addon-pipeline/src/**',
    '    - packages/types/src/pipeline/**',
    '',
    '- id: auth',
    '  title: Auth',
    '  purpose: Who may call what.',
    '  globs:',
    '    - packages/addon-auth/src/**',
  ].join('\n')

  it('parses entries, folded purpose, and an absent owner-doc', () => {
    const entries = parseSubsystemsYaml(YAML)
    expect(entries.map((e) => e.id)).toEqual(['pipeline', 'auth'])
    expect(entries[0].title).toBe('Pipeline — decode and detect')
    expect(entries[0].purpose).toBe('Turns a stream into frames, then into detections.')
    expect(entries[0].ownerDoc).toBe('docs/architecture/data-planes.md')
    expect(entries[0].globs).toEqual([
      'packages/addon-pipeline/src/**',
      'packages/types/src/pipeline/**',
    ])
    expect(entries[1].ownerDoc).toBeNull()
    expect(entries[1].purpose).toBe('Who may call what.')
  })

  it('rejects a duplicate id rather than silently keeping one', () => {
    expect(() => parseSubsystemsYaml('- id: a\n  title: A\n- id: a\n  title: A again\n')).toThrow(
      /duplicate/i,
    )
  })
})

describe('the join — files, subsystems, documents', () => {
  it('a file matched by two subsystems appears under both', () => {
    const map = buildSubsystemMap(
      input({
        taxonomy: [
          PIPELINE,
          { ...CAPS, globs: ['packages/types/src/capabilities/**', 'packages/addon-pipeline/**'] },
        ],
      }),
    )
    expect(view(map, 'pipeline').files).toContain('packages/addon-pipeline/src/runner.ts')
    expect(view(map, 'capabilities').files).toContain('packages/addon-pipeline/src/runner.ts')
    expect(map.orphans).toEqual([])
  })

  it('a doc whose `applies-to` matches ONE file claims the whole subsystem', () => {
    const map = buildSubsystemMap(
      input({
        docs: [
          doc({ appliesTo: ['packages/addon-pipeline/src/runner.ts'], lastVerified: '2026-08-01' }),
        ],
      }),
    )
    const pipeline = view(map, 'pipeline')
    expect(pipeline.docs.map((d) => d.doc)).toEqual(['docs/architecture/pipeline.md'])
    expect(pipeline.docs[0].via).toBe('applies-to')
    expect(pipeline.claimedFiles).toBe(1)
    expect(pipeline.uncoveredFiles).toEqual(['packages/addon-pipeline/src/decode.ts'])
  })

  it('a subsystem no document claims renders ❌ and is counted as uncovered', () => {
    const map = buildSubsystemMap(input())
    expect(view(map, 'pipeline').status).toBe('uncovered')
    expect(map.uncoveredSubsystems).toBe(2)
    expect(renderSubsystemsPage(map, '')).toContain('❌')
  })

  it('a `covers:`-only document still closes the coverage hole', () => {
    const map = buildSubsystemMap(
      input({
        docs: [
          doc({
            doc: 'docs/architecture/device-model.md',
            covers: ['packages/addon-pipeline/src/**'],
            lastVerified: '2026-08-14',
          }),
        ],
      }),
    )
    const pipeline = view(map, 'pipeline')
    expect(pipeline.status).not.toBe('uncovered')
    expect(pipeline.docs[0].via).toBe('covers')
    expect(pipeline.uncoveredFiles).toEqual([])
  })

  it('marks a subsystem ✅ only when its OWN owner-doc claims it', () => {
    const claimAll = { appliesTo: ['packages/addon-pipeline/src/**'], lastVerified: '2026-08-14' }
    const byOther = buildSubsystemMap(
      input({ docs: [doc({ doc: 'docs/decisions/adr-0001.md', ...claimAll })] }),
    )
    expect(view(byOther, 'pipeline').status).toBe('partial')

    const byOwner = buildSubsystemMap(input({ docs: [doc(claimAll)] }))
    expect(view(byOwner, 'pipeline').status).toBe('covered')
  })

  it('reports the freshest `last-verified` among the claiming documents', () => {
    const map = buildSubsystemMap(
      input({
        docs: [
          doc({ appliesTo: ['packages/addon-pipeline/src/**'], lastVerified: '2026-01-02' }),
          doc({
            doc: 'docs/decisions/adr-0002.md',
            appliesTo: ['packages/addon-pipeline/src/decode.ts'],
            lastVerified: '2026-07-07',
          }),
        ],
      }),
    )
    expect(view(map, 'pipeline').freshest).toBe('2026-07-07')
  })

  it('pivots the same data by unit for the coverage page', () => {
    const map = buildSubsystemMap(
      input({ docs: [doc({ appliesTo: ['packages/addon-pipeline/src/**'] })] }),
    )
    const unit = map.units.find((u) => u.unit === 'packages/addon-pipeline')
    expect(unit).toBeDefined()
    expect(unit?.files).toBe(2)
    expect(unit?.docs.map((d) => d.doc)).toEqual(['docs/architecture/pipeline.md'])
    expect(unit?.subsystems).toEqual(['pipeline'])
    expect(renderCoveragePage(map, '')).toContain('packages/addon-pipeline')
  })

  it('splits a large package into per-directory units', () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      i < 40 ? `packages/big/src/alpha/f${String(i)}.ts` : `packages/big/src/beta/f${String(i)}.ts`,
    )
    const map = buildSubsystemMap(
      input({
        taxonomy: [{ ...PIPELINE, globs: ['packages/big/**'] }],
        sourceFiles: many,
      }),
    )
    expect(map.units.map((u) => u.unit).toSorted()).toEqual([
      'packages/big/src/alpha',
      'packages/big/src/beta',
    ])
  })
})

describe('guard', () => {
  it('fails on a glob that matches nothing — the subsystem outlived its code', () => {
    const map = buildSubsystemMap(
      input({ taxonomy: [{ ...PIPELINE, globs: ['packages/addon-gone/src/**'] }, CAPS] }),
    )
    expect(map.deadGlobs).toEqual([{ id: 'pipeline', glob: 'packages/addon-gone/src/**' }])
    const kinds = findSubsystemProblems(map, 99).map((p) => p.kind)
    expect(kinds).toContain('dead-glob')
  })

  it('fails on an owner-doc that does not resolve', () => {
    const map = buildSubsystemMap(
      input({ taxonomy: [{ ...PIPELINE, ownerDoc: 'docs/architecture/nope.md' }, CAPS] }),
    )
    expect(map.missingOwnerDocs).toEqual([{ id: 'pipeline', doc: 'docs/architecture/nope.md' }])
    expect(findSubsystemProblems(map, 99).map((p) => p.kind)).toContain('missing-owner-doc')
  })

  it('counts a source file in no subsystem as an orphan, and ratchets on the count', () => {
    const map = buildSubsystemMap(
      input({
        taxonomy: [PIPELINE],
        sourceFiles: [
          'packages/addon-pipeline/src/runner.ts',
          'packages/nobody/src/a.ts',
          'packages/nobody/src/b.ts',
        ],
      }),
    )
    expect(map.orphans).toEqual(['packages/nobody/src/a.ts', 'packages/nobody/src/b.ts'])
    expect(findSubsystemProblems(map, 2)).toEqual([])
    expect(findSubsystemProblems(map, 1).map((p) => p.kind)).toEqual(['orphans'])
  })

  it('says so when the ratchet no longer binds, without failing', () => {
    const map = buildSubsystemMap(
      input({ taxonomy: [PIPELINE], sourceFiles: ['packages/addon-pipeline/src/runner.ts'] }),
    )
    expect(map.orphans).toEqual([])
    expect(findSubsystemProblems(map, 5)).toEqual([])
  })

  it('renders deterministically — identical input, identical page', () => {
    const built = () => buildSubsystemMap(input({ docs: [doc({ appliesTo: ['packages/**'] })] }))
    expect(renderSubsystemsPage(built(), 'B')).toBe(renderSubsystemsPage(built(), 'B'))
    expect(renderCoveragePage(built(), 'B')).toBe(renderCoveragePage(built(), 'B'))
  })
})
