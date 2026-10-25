/**
 * The block editor's type wiring.
 *
 * A "TypeScript editor" whose declaration files silently failed to load looks
 * EXACTLY like one that works — the code highlights, the cursor moves, nothing
 * complains — right up until someone tries to autocomplete `ctx.` and gets
 * nothing, or worse, writes against a method that does not exist and finds out
 * at fork time. So the wiring is asserted rather than assumed.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyExtraLibs,
  BLOCK_COMPILER_OPTIONS,
  hasBlockingErrors,
  projectFileExtraLibs,
  type EditorExtraLib,
} from '../CodeEditor.js'

/** The slice of Monaco `applyExtraLibs` touches. */
function fakeMonaco() {
  const state = {
    compilerOptions: { target: 1 } as Record<string, unknown>,
    extraLibs: [] as { filePath: string; content: string }[],
  }
  const monaco = {
    languages: {
      typescript: {
        typescriptDefaults: {
          getCompilerOptions: () => state.compilerOptions,
          setCompilerOptions: vi.fn((o: Record<string, unknown>) => {
            state.compilerOptions = o
          }),
          setExtraLibs: vi.fn((libs: { filePath: string; content: string }[]) => {
            state.extraLibs = libs
          }),
        },
      },
    },
  }
  return { monaco, state }
}

const libs: readonly EditorExtraLib[] = [
  {
    filePath: 'file:///node_modules/@camstack/types/index.d.ts',
    content: 'export interface BlockContext { readonly devices: unknown }',
  },
]

describe('applyExtraLibs', () => {
  it('registers the declaration files with the compiler', () => {
    const { monaco, state } = fakeMonaco()
    // Documented boundary: the fake implements only the surface used here.
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], libs)
    expect(state.extraLibs).toHaveLength(1)
    expect(state.extraLibs[0].filePath).toContain('@camstack/types')
  })

  it('keeps a path that lets `import … from "@camstack/types"` resolve', () => {
    // Monaco resolves imports against the extra-lib paths. A file registered as
    // `types.d.ts` loads and then resolves nothing, which is the failure that
    // looks like success.
    expect(libs[0].filePath.startsWith('file:///node_modules/')).toBe(true)
  })

  it('applies the strict options a block is compiled under, without dropping the rest', () => {
    // Code that typechecks in the editor must compile at fork time; a laxer
    // editor is an editor that green-lights code the runner rejects.
    const { monaco, state } = fakeMonaco()
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], libs)
    expect(state.compilerOptions.strict).toBe(true)
    expect(state.compilerOptions.noImplicitAny).toBe(true)
    expect(state.compilerOptions.strictNullChecks).toBe(true)
    // Merged onto whatever was there, not replacing it wholesale.
    expect(state.compilerOptions.target).toBe(BLOCK_COMPILER_OPTIONS.target)
  })

  it('replaces the libs rather than appending — reopening the editor must not stack them', () => {
    const { monaco, state } = fakeMonaco()
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], libs)
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], libs)
    expect(state.extraLibs).toHaveLength(1)
  })

  it('an empty lib set is registered as empty, not skipped', () => {
    // Otherwise a failed fetch silently leaves the PREVIOUS types in place and
    // the editor validates against a stale contract.
    const { monaco, state } = fakeMonaco()
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], libs)
    applyExtraLibs(monaco as unknown as Parameters<typeof applyExtraLibs>[0], [])
    expect(state.extraLibs).toEqual([])
  })
})

describe('hasBlockingErrors', () => {
  it('blocks on an error and not on a warning', () => {
    // Saving code that does not typecheck stores something that fails at fork
    // time, where the operator is no longer looking at it.
    expect(hasBlockingErrors([{ line: 1, column: 1, message: 'x', severity: 8 }])).toBe(true)
    expect(hasBlockingErrors([{ line: 1, column: 1, message: 'x', severity: 4 }])).toBe(false)
    expect(hasBlockingErrors([])).toBe(false)
  })
})

describe('projectFileExtraLibs', () => {
  it('registers siblings under both .ts and .js so Node ESM imports resolve', () => {
    // Blocks import `./tv-scrape.js`; without the .js twin Monaco reports
    // "Cannot find module" even though the server compile finds the .ts file.
    const libs = projectFileExtraLibs(
      {
        'main.ts': "import { scrape } from './tv-scrape.js'\n",
        'tv-scrape.ts': 'export function scrape(): string { return "" }\n',
      },
      'main.ts',
    )
    const paths = libs.map((l) => l.filePath).toSorted()
    expect(paths).toEqual(['file:///tv-scrape.js', 'file:///tv-scrape.ts'])
    expect(libs.every((l) => l.content.includes('export function scrape'))).toBe(true)
  })

  it('skips the active file — that buffer is the editor model, not a lib', () => {
    const libs = projectFileExtraLibs(
      { 'main.ts': 'export {}\n', 'helper.ts': 'export {}\n' },
      'main.ts',
    )
    expect(libs.map((l) => l.filePath)).not.toContain('file:///main.ts')
  })
})
