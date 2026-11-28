/**
 * The editor of an automation "Run code" step.
 *
 * The snippet is pasted by codegen as the body of `await (async () => { … })()`
 * inside the automation's block, where `ctx` (the block's `AddonContext`) and
 * `vars` (the run's variable bag) are in scope. The editor therefore checks the
 * user's text as an async function body: an ambient lib declares those two names
 * (`ctx` typed from the SAME hub type libs the Scripts editor uses), and the
 * diagnostics a script-vs-module check would raise for top-level `await` and
 * `return` are ignored. The model holds only what the operator typed, so every
 * marker is on the operator's own lines.
 */

import { useSystem, useThemeMode } from '@dominevo/ui-library'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { CodeEditor, type EditorExtraLib } from './CodeEditor'
import { STEP_IGNORED_DIAGNOSTICS, stepExtraLibs } from './automation-code-step'

export interface BlockTypeLibsResult {
  readonly libs: readonly EditorExtraLib[]
}

export const BLOCK_TYPEDEFS_KEY = ['coreBlocks', 'getTypeDefs'] as const

export interface AutomationCodeEditorProps {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly heightPx?: number
}

export function AutomationCodeEditor({
  value,
  onChange,
  heightPx = 220,
}: AutomationCodeEditorProps) {
  const system = useSystem()
  const { resolvedMode } = useThemeMode()
  const typeDefs = useQuery({
    queryKey: BLOCK_TYPEDEFS_KEY,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: (): Promise<BlockTypeLibsResult> => system.trpcClient.coreBlocks.getTypeDefs.query({}),
  })
  const libs = useMemo(() => stepExtraLibs(typeDefs.data?.libs ?? []), [typeDefs.data?.libs])
  return (
    <CodeEditor
      value={value}
      onChange={onChange}
      path="file:///automation-step.ts"
      extraLibs={libs}
      ignoreDiagnosticCodes={STEP_IGNORED_DIAGNOSTICS}
      heightPx={heightPx}
      dark={resolvedMode === 'dark'}
    />
  )
}
