/**
 * D936/D944/D984/D1004 — every declared Customize surface has a renderer. The
 * tree on main is covered; a missing renderer, title or link reader is a hit.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAP_CUSTOMIZE_CATALOG } from '../../packages/types/src/generated/customize-catalog.ts'
import {
  CUSTOMIZE_APPLY_AUTHORITY_KINDS,
  CUSTOMIZE_CARDINALITIES,
  CUSTOMIZE_EVENT_SHAPES,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import { COMPOSITION_LINK_KINDS } from '../../packages/types/src/composition/composition-link-kinds.ts'
import { CUSTOMIZE_KINDS } from '../../packages/addon-admin-ui/src/components/device/customize/customize-spec.ts'
import { EXTENSION_SLOT_IDS } from '../../packages/types/src/generated/extension-slots.ts'
import {
  type CoverageInput,
  customizeCoverageHits,
  listKindFiles,
  listLinkSources,
  readRepoFile,
} from '../lib/customize-coverage.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const caps = Object.keys(CAP_CUSTOMIZE_CATALOG)

const base: CoverageInput = {
  catalog: CAP_CUSTOMIZE_CATALOG,
  cardinalities: CUSTOMIZE_CARDINALITIES,
  eventShapes: CUSTOMIZE_EVENT_SHAPES,
  authorityKinds: CUSTOMIZE_APPLY_AUTHORITY_KINDS,
  slotIds: EXTENSION_SLOT_IDS,
  linkKinds: COMPOSITION_LINK_KINDS,
  linkSources: listLinkSources(repoRoot),
  customizeKinds: CUSTOMIZE_KINDS,
  kindFiles: listKindFiles(repoRoot),
  i18nCapTitles: { en: caps, it: caps },
  read: (file) => readRepoFile(repoRoot, file),
}

describe('customize coverage guard', () => {
  it('the tree on main has a renderer for everything declared', () => {
    expect(customizeCoverageHits(base)).toEqual([])
  })

  it('an extension slot with no section is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      slotIds: [...EXTENSION_SLOT_IDS, 'doorbell-sources'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['extension slot doorbell-sources'])
  })

  it('a link kind with no renderer entry is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      linkKinds: [...COMPOSITION_LINK_KINDS, 'valve-flow'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['link valve-flow'])
  })

  it('a stored-link module nobody registered is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      linkSources: [...base.linkSources, 'packages/types/src/composition/valve-flow-link.ts'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual([
      'link module packages/types/src/composition/valve-flow-link.ts',
    ])
  })

  it('the link modules on disk are exactly the registered kinds', () => {
    expect(listLinkSources(repoRoot)).toEqual([
      'packages/types/src/composition/cap-link.ts',
      'packages/types/src/composition/lock-door-link.ts',
      'packages/types/src/composition/power-source-link.ts',
    ])
  })

  it('a link whose renderer file no longer reads it is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      read: (file) =>
        file.endsWith('lock-hero-card.tsx') ? 'export const x = 1\n' : base.read(file),
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['link lock-door-sensor'])
  })

  it('a cardinality the row table does not name is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      cardinalities: [...CUSTOMIZE_CARDINALITIES, 'matrix'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['cardinality matrix'])
  })

  it('an event shape with no card is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      eventShapes: [...CUSTOMIZE_EVENT_SHAPES, 'burst'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['event shape burst'])
  })

  it('an apply authority no surface reads is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      authorityKinds: [...CUSTOMIZE_APPLY_AUTHORITY_KINDS, 'cloud'],
    })
    expect(hits.map((hit) => hit.surface)).toEqual(['apply authority cloud'])
  })

  it('a catalog cap without a title in one locale is a hit', () => {
    const hits = customizeCoverageHits({
      ...base,
      i18nCapTitles: { en: caps, it: caps.slice(1) },
    })
    expect(hits.map((hit) => hit.surface)).toEqual([`cap ${caps[0]}`])
  })

  it('a kind with no registry entry is a hit', () => {
    const hits = customizeCoverageHits({ ...base, customizeKinds: [...CUSTOMIZE_KINDS, 'dimmer'] })
    expect(hits.map((hit) => hit.surface)).toEqual(['customize kind dimmer'])
  })

  it('a Checkbox or a loose device picker in a kind folder is a hit, a comment is not', () => {
    const file = 'packages/addon-admin-ui/src/components/device/customize/kinds/X.tsx'
    const text = (body: string) => (path: string) => (path === file ? body : base.read(path))
    const checkbox = customizeCoverageHits({
      ...base,
      kindFiles: [file],
      read: text("import { Checkbox } from '@camstack/ui-library'"),
    })
    expect(checkbox.map((hit) => hit.surface)).toEqual([`kind folder ${file}`])
    const picker = customizeCoverageHits({
      ...base,
      kindFiles: [file],
      read: text('return <DevicePicker items={[]} />'),
    })
    expect(picker).toHaveLength(1)
    const comment = customizeCoverageHits({
      ...base,
      kindFiles: [file],
      read: text(' * a DevicePicker behind the SourceSelector'),
    })
    expect(comment).toEqual([])
  })
})
