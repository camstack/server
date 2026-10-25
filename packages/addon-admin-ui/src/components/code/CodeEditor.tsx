/**
 * The TypeScript editor core blocks are authored in.
 *
 * Monaco, configured so the code an operator writes is checked against the
 * SYSTEM'S OWN TYPES rather than a hand-written stub. That distinction is the
 * whole point: a block is executed with the same `ctx` an addon gets, so a stub
 * would drift from it and the editor would confidently autocomplete methods
 * that do not exist.
 *
 * The type graph is 3.4 MB across 344 declaration files, so it is NOT bundled —
 * `extraLibs` is injected by the caller (fetched from the hub, cached) and
 * registered before the model is created. `onDiagnostics` reports what the
 * compiler found, so a caller can refuse to save code that does not typecheck
 * instead of storing something that will fail at fork time.
 */

import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useCallback, useEffect, useRef } from 'react'

/** One declaration file handed to the compiler. */
export interface EditorExtraLib {
  /** Virtual path. Imports resolve against these, so the path matters:
   *  `file:///node_modules/@camstack/types/index.d.ts` makes
   *  `import … from '@camstack/types'` resolve. */
  readonly filePath: string
  readonly content: string
}

/** What the compiler found, flattened for a caller that only needs to gate. */
export interface EditorDiagnostic {
  readonly line: number
  readonly column: number
  readonly message: string
  /** `8` is Monaco's Error severity; anything lower is advisory. */
  readonly severity: number
}

export interface CodeEditorProps {
  readonly value: string
  readonly onChange: (next: string) => void
  /** Declaration files the code is checked against. */
  readonly extraLibs?: readonly EditorExtraLib[]
  /**
   * Model URI for the buffer being edited. Must match the project file path
   * (`file:///main.ts`) so sibling imports resolve against other project libs.
   * Defaults to `file:///block.ts` for single-buffer callers.
   */
  readonly path?: string
  /** Called whenever the compiler's markers change. */
  readonly onDiagnostics?: (diagnostics: readonly EditorDiagnostic[]) => void
  readonly readOnly?: boolean
  readonly heightPx?: number
  /** Follows the admin theme; Monaco has no CSS-variable theming. */
  readonly dark?: boolean
}

/**
 * Sibling files of a multi-file script, registered so Monaco can resolve
 * `import './tv-scrape.js'` the same way the server-side compile does.
 *
 * Each `.ts` file is also exposed under its `.js` twin: blocks import with the
 * Node ESM extension, and Monaco's Node moduleResolution looks for that name.
 */
export function projectFileExtraLibs(
  files: Readonly<Record<string, string>>,
  activePath: string,
): readonly EditorExtraLib[] {
  const libs: EditorExtraLib[] = []
  for (const [path, content] of Object.entries(files)) {
    if (path === activePath) continue
    libs.push({ filePath: `file:///${path}`, content })
    if (path.endsWith('.ts')) {
      libs.push({ filePath: `file:///${path.slice(0, -3)}.js`, content })
    }
  }
  return libs
}

/** The compiler options a block is checked under — the same strictness the
 *  repo itself uses, so code that passes here compiles at fork time. */
export const BLOCK_COMPILER_OPTIONS = {
  target: 99, // ESNext
  module: 99, // ESNext
  moduleResolution: 2, // Node
  strict: true,
  noImplicitAny: true,
  strictNullChecks: true,
  allowNonTsExtensions: true,
  // A block is a module (it exports its entry point), never a script.
  isolatedModules: true,
} as const

/**
 * Register the declaration files with the TS worker.
 *
 * Exported and pure-ish so the wiring can be asserted: a "TypeScript editor"
 * whose types silently failed to load looks exactly like one that works, right
 * up until someone tries to autocomplete `ctx.`.
 */
export function applyExtraLibs(monaco: Monaco, libs: readonly EditorExtraLib[]): void {
  const ts = monaco.languages.typescript.typescriptDefaults
  ts.setCompilerOptions({ ...ts.getCompilerOptions(), ...BLOCK_COMPILER_OPTIONS })
  ts.setExtraLibs(libs.map((lib) => ({ filePath: lib.filePath, content: lib.content })))
}

export function CodeEditor({
  value,
  onChange,
  extraLibs = [],
  path = 'file:///block.ts',
  onDiagnostics,
  readOnly = false,
  heightPx = 420,
  dark = true,
}: CodeEditorProps) {
  const monacoRef = useRef<Monaco | null>(null)

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      monacoRef.current = monaco
      applyExtraLibs(monaco, extraLibs)

      if (onDiagnostics === undefined) return
      const model = editor.getModel()
      if (model === null) return
      const report = (): void => {
        onDiagnostics(
          monaco.editor.getModelMarkers({ resource: model.uri }).map((m: MonacoEditor.IMarker) => ({
            line: m.startLineNumber,
            column: m.startColumn,
            message: m.message,
            severity: m.severity,
          })),
        )
      }
      // Markers arrive asynchronously from the TS worker, so subscribe rather
      // than reading once — a first read always returns an empty list.
      monaco.editor.onDidChangeMarkers(report)
      report()
    },
    [extraLibs, onDiagnostics],
  )

  // onMount runs once; sibling project files and hub typedefs arrive later.
  useEffect(() => {
    const monaco = monacoRef.current
    if (monaco === null) return
    applyExtraLibs(monaco, extraLibs)
  }, [extraLibs])

  return (
    <Editor
      height={heightPx}
      defaultLanguage="typescript"
      // Path is the project file URI so relative imports resolve against
      // sibling libs registered in `extraLibs`.
      path={path}
      theme={dark ? 'vs-dark' : 'vs'}
      value={value}
      onChange={(next) => onChange(next ?? '')}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
      }}
    />
  )
}

/** True when the compiler reported at least one ERROR (severity 8). */
export function hasBlockingErrors(diagnostics: readonly EditorDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity >= 8)
}
