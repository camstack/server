/**
 * D1050 guard — the cap vocabulary is generated from the caps, never written
 * by hand. Each case adds one hand-written entry to a clean tree and expects
 * exactly the complaint that names it.
 */
import { describe, expect, it } from 'vitest'
import {
  findHandwrittenVocabulary,
  GENERATED_VOCABULARY,
  RETIRED_ENTRIES_DIR,
  VOCABULARY_MODULE,
  type VocabularySourceFile,
} from '../lib/handwritten-cap-vocabulary.ts'

const clean: readonly VocabularySourceFile[] = [
  {
    path: VOCABULARY_MODULE,
    text: "import { CAP_VOCABULARY } from '../../generated/cap-vocabulary.js'\nexport const BY_NAME = CAP_VOCABULARY satisfies CapVocabularyMap\n",
  },
  { path: GENERATED_VOCABULARY, text: 'export const CAP_VOCABULARY: CapVocabularyMap = {}\n' },
  {
    path: 'packages/types/src/capabilities/switch.cap.ts',
    text: "export const switchCapability = { vocabulary: { noun: t('Switch', 'Interruttore'), order: 1000 } }\n",
  },
]

describe('check-no-handwritten-cap-vocabulary', () => {
  it('accepts a tree whose vocabulary is generated', () => {
    expect(findHandwrittenVocabulary(clean)).toEqual([])
  })

  it('refuses a file back under the retired entries directory', () => {
    const problems = findHandwrittenVocabulary([
      ...clean,
      { path: `${RETIRED_ENTRIES_DIR}lights.ts`, text: 'export const X = {}\n' },
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('entries are retired')
  })

  it('refuses a value typed as an entry of the map anywhere else', () => {
    for (const type of [
      'DeviceCapVocabulary<"switch">',
      'SystemCapVocabulary',
      'CapVocabularyMap',
    ]) {
      const problems = findHandwrittenVocabulary([
        ...clean,
        {
          path: 'packages/addon-admin-ui/src/extra-vocab.ts',
          text: `import x from 'y'\nexport const EXTRA: ${type} = { scope: 'device' }\n`,
        },
      ])
      expect(problems).toEqual([
        expect.stringContaining('packages/addon-admin-ui/src/extra-vocab.ts:2: a value typed'),
      ])
    }
  })

  it('refuses a `satisfies` entry as well as an annotated one', () => {
    const problems = findHandwrittenVocabulary([
      ...clean,
      {
        path: 'packages/types/src/device/more.ts',
        text: "export const MORE = { scope: 'system' } satisfies SystemCapVocabulary\n",
      },
    ])
    expect(problems).toHaveLength(1)
  })

  it('refuses a vocabulary module that stops reading the generated map', () => {
    const problems = findHandwrittenVocabulary([
      { path: VOCABULARY_MODULE, text: 'export const CAP_VOCABULARY = {}\n' },
      ...clean.slice(1),
    ])
    expect(problems).toEqual([expect.stringContaining('must be the generated map')])
  })

  it('ignores specs and comments that name the types', () => {
    expect(
      findHandwrittenVocabulary([
        ...clean,
        {
          path: 'packages/types/src/x/__tests__/a.spec.ts',
          text: 'const a: CapVocabularyMap = {}\n',
        },
        { path: 'packages/types/src/x/doc.ts', text: ' * typed: CapVocabularyMap here\n' },
      ]),
    ).toEqual([])
  })
})
