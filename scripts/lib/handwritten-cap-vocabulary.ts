/**
 * The judge of `check-no-handwritten-cap-vocabulary` (D1050): the cap
 * vocabulary is declared on the caps and generated — no source file may hold
 * an entry of the map by hand. Pure: the CLI hands it the files.
 */

/** One source file, by repo-relative path. */
export interface VocabularySourceFile {
  readonly path: string
  readonly text: string
}

/** Where the hand-written entries used to live; nothing may come back there. */
export const RETIRED_ENTRIES_DIR = 'packages/types/src/device/cap-vocabulary/entries/'

/** The generated map — the only value typed as the map or one of its entries. */
export const GENERATED_VOCABULARY = 'packages/types/src/generated/cap-vocabulary.ts'

/** The module that reads the generated map and re-exports it. */
export const VOCABULARY_MODULE = 'packages/types/src/device/cap-vocabulary/vocabulary.ts'

/** The module that defines the entry types (it names them, it holds no value). */
const VOCABULARY_TYPES = 'packages/types/src/device/cap-vocabulary/types.ts'

/** The entry types: a value annotated with one of them is an entry written by hand. */
const ENTRY_TYPES = [
  'CapVocabularyMap',
  'CapVocabularyEntry',
  'DeviceCapVocabulary',
  'SystemCapVocabulary',
  'CapVocabularySlice',
] as const

const ENTRY_TYPE_ANNOTATION = new RegExp(
  `(?::|\\bsatisfies)\\s*(?:Readonly<\\s*)?(?:Partial<\\s*)?(${ENTRY_TYPES.join('|')})\\b`,
)

function isSpec(file: string): boolean {
  return /(?:^|\/)__tests__\//.test(file) || /\.spec\.tsx?$/.test(file)
}

/** Every hand-written vocabulary entry the files hold, one problem each. */
export function findHandwrittenVocabulary(
  files: readonly VocabularySourceFile[],
): readonly string[] {
  const problems: string[] = []
  let vocabularyModuleSeen = false
  for (const file of files) {
    if (file.path.startsWith(RETIRED_ENTRIES_DIR)) {
      problems.push(
        `${file.path}: the hand-written vocabulary entries are retired — declare the action on its method, the event wording on its event, the rest in the cap's \`vocabulary\` block, then \`npm run codegen\``,
      )
      continue
    }
    if (file.path === VOCABULARY_MODULE) {
      vocabularyModuleSeen = true
      if (!file.text.includes("from '../../generated/cap-vocabulary.js'"))
        problems.push(
          `${file.path}: CAP_VOCABULARY must be the generated map (\`../../generated/cap-vocabulary.js\`)`,
        )
    }
    if (file.path === GENERATED_VOCABULARY || file.path === VOCABULARY_TYPES) continue
    if (isSpec(file.path)) continue
    const lines = file.text.split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return
      const match = ENTRY_TYPE_ANNOTATION.exec(line)
      if (match === null) return
      if (file.path === VOCABULARY_MODULE && match[1] === 'CapVocabularyMap') return
      problems.push(
        `${file.path}:${i + 1}: a value typed \`${match[1]}\` is a hand-written vocabulary entry — declare it on the cap (D1050)`,
      )
    })
  }
  if (!vocabularyModuleSeen) problems.push(`${VOCABULARY_MODULE}: missing`)
  return problems
}
