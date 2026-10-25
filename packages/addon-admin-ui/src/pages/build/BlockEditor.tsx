/**
 * The panel a core block is authored in — and the whole loop that replaces a
 * test button.
 *
 * Two gates stand between what is typed here and a forked process, and they are
 * deliberately the SAME compiler:
 *
 *  1. Monaco, checked against the node's own declaration files (fetched via
 *     `getTypeDefs`, never bundled — the graph is 3.4 MB across 344 files).
 *  2. `coreBlocks.compile` / `create` / `update`, which compile server-side.
 *     The write path REFUSES code that does not compile. That one is
 *     authoritative; Monaco exists so the verdict arrives in the editor instead
 *     of in a log fifteen seconds later, and **Compile** exists so the operator
 *     can ask the authoritative one without storing anything.
 *
 * Save is blocked on Monaco's errors rather than merely warned about, because a
 * block stored broken is a block whose process fails at fork time — far from
 * the person who wrote it, and looking exactly like a runtime failure.
 *
 * **Restart is blocked while the editor is dirty.** A restart that silently
 * runs the OLD code is the failure mode this ordering exists to avoid, and it
 * is the entire reason the loop is Compile → Save → Restart rather than a
 * single "run it" verb. There is deliberately no Test button (design §3.1.1).
 */

import {
  type CoreBlock,
  type CoreBlockCompileResult,
  type CoreBlockInput,
  coreBlockAddonId,
  resolveCoreBlockFiles,
} from '@camstack/types'
import {
  Badge,
  Button,
  Input,
  LogStream,
  NodePicker,
  useConfirm,
  useSystem,
  useThemeMode,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, RotateCw, ScrollText } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  CodeEditor,
  type EditorDiagnostic,
  hasBlockingErrors,
  projectFileExtraLibs,
} from '../../components/code/CodeEditor'
import { NEW_BLOCK_TEMPLATE } from './block-template'
import { badgeVariantForTone, describeBlockStatus } from './core-block-status'
import { nextScriptFilePath, SCRIPT_EXAMPLES, type ScriptExample } from './examples'
import { restartReason } from './restart-gate'
import { ScriptDevicesPanel } from './ScriptDevicesPanel'
import { ScriptSettingsPanel } from './ScriptSettingsPanel'
import { Trans, useTranslation } from 'react-i18next'

/** Declaration files, in the shape `CodeEditor` wants them. */
export interface BlockTypeLibs {
  readonly libs: readonly {
    readonly filePath: string
    readonly content: string
  }[]
}

export interface BlockEditorProps {
  /** null = creating. Re-read from the polled list by the caller, so the status
   *  badge and the "code the server accepted" are both live. */
  readonly existing: CoreBlock | null
  readonly typeDefs: BlockTypeLibs | undefined
  readonly typeDefsLoading: boolean
  readonly saving: boolean
  /** Server-side compile/store failure, verbatim. */
  readonly saveError: string | null
  readonly restarting: boolean
  readonly restartError: string | null
  /** Absent while creating — there is no runner to restart yet. */
  readonly onRestart?: () => void
  readonly onSave: (input: CoreBlockInput) => void
  readonly onCancel: () => void
}

/**
 * Execution is hub-only today, and the addon says so by marking a block placed
 * elsewhere `failed`. Saying it here as well is not duplication: an operator who
 * discovers the limit from a red badge has already saved something that cannot
 * run.
 */
const HUB = 'hub'

export function BlockEditor({
  existing,
  typeDefs,
  typeDefsLoading,
  saving,
  saveError,
  restarting,
  restartError,
  onRestart,
  onSave,
  onCancel,
}: BlockEditorProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const confirm = useConfirm()
  const { resolvedMode } = useThemeMode()
  const initialFiles = resolveCoreBlockFiles({
    code: existing?.code ?? NEW_BLOCK_TEMPLATE,
    files: existing?.files,
    entry: existing?.entry,
  })
  const [name, setName] = useState(existing?.name ?? '')
  const [files, setFiles] = useState<Record<string, string>>(initialFiles.files)
  const [entry, setEntry] = useState(initialFiles.entry)
  const [activeFile, setActiveFile] = useState(initialFiles.entry)
  const [placement, setPlacement] = useState(existing?.placement ?? HUB)
  const [integrationId, setIntegrationId] = useState(existing?.integrationId ?? '')
  const [diagnostics, setDiagnostics] = useState<readonly EditorDiagnostic[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [exampleId, setExampleId] = useState('blank')
  /** Path being renamed inline — null when no tab is editing its name. */
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const code = files[activeFile] ?? ''
  const setCode = (next: string): void => {
    setFiles((prev) => ({ ...prev, [activeFile]: next }))
  }
  const filePaths = Object.keys(files).toSorted()
  const offerExamples = SCRIPT_EXAMPLES.length > 1
  const editorLibs = useMemo(
    () => [...(typeDefs?.libs ?? []), ...projectFileExtraLibs(files, activeFile)],
    [typeDefs?.libs, files, activeFile],
  )

  const compile = useMutation({
    mutationFn: (): Promise<CoreBlockCompileResult> =>
      system.trpcClient.coreBlocks.compile.mutate({ files, entry }),
  })

  const errors = useMemo(() => diagnostics.filter((d) => d.severity >= 8), [diagnostics])
  const blocked = hasBlockingErrors(diagnostics)
  const nameMissing = name.trim() === ''

  /**
   * Whether what is on screen differs from what the SERVER accepted.
   *
   * `existing` is re-read from the list on every poll, so `existing.code` is
   * literally the stored source — not a local copy of it that could drift. That
   * is what makes it safe to gate Restart on: a restart while this is true
   * would run the last saved code while the operator watched the new code.
   */
  const stored = existing === null ? null : resolveCoreBlockFiles(existing)
  const dirty =
    existing === null ||
    stored === null ||
    JSON.stringify(files) !== JSON.stringify(stored.files) ||
    entry !== stored.entry ||
    name.trim() !== existing.name ||
    placement !== existing.placement ||
    (integrationId.trim() === '' ? undefined : integrationId.trim()) !== existing.integrationId

  const save = (): void => {
    compile.reset()
    onSave({
      name: name.trim(),
      files,
      entry,
      enabled: existing?.enabled ?? true,
      placement,
      ...(integrationId.trim() !== '' ? { integrationId: integrationId.trim() } : {}),
    })
  }

  const addFile = (): void => {
    const key = nextScriptFilePath(Object.keys(files))
    setFiles((prev) => ({ ...prev, [key]: '' }))
    setActiveFile(key)
    setRenamingPath(key)
    setRenameDraft(key)
  }

  const beginRename = (path: string): void => {
    setRenamingPath(path)
    setRenameDraft(path)
  }

  const commitRename = (): void => {
    if (renamingPath === null) return
    const from = renamingPath
    const to = renameDraft.trim()
    setRenamingPath(null)
    if (to === '' || to === from) return
    if (files[to] !== undefined) {
      setActiveFile(to)
      return
    }
    setFiles((prev) => {
      const next: Record<string, string> = {}
      for (const [path, body] of Object.entries(prev)) {
        next[path === from ? to : path] = body
      }
      return next
    })
    if (entry === from) setEntry(to)
    setActiveFile(to)
  }

  const applyExample = async (nextId: string): Promise<void> => {
    const example: ScriptExample | undefined = SCRIPT_EXAMPLES.find((e) => e.id === nextId)
    if (example === undefined) return
    const blank = SCRIPT_EXAMPLES.find((e) => e.id === 'blank')
    const stillBlank =
      blank !== undefined &&
      JSON.stringify(files) === JSON.stringify(blank.files) &&
      entry === blank.entry
    if (!stillBlank) {
      const ok = await confirm({
        title: t('build.blockEditor.loadExample', 'Load example'),
        message: t(
          'build.blockEditor.replaceTheCurrentEditorContents',
          'Replace the current editor contents with this example?',
        ),
        confirmLabel: t('build.blockEditor.replace', 'Replace'),
        variant: 'warning',
      })
      if (!ok) return
    }
    setExampleId(nextId)
    setFiles({ ...example.files })
    setEntry(example.entry)
    setActiveFile(example.entry)
    if (name.trim() === '' || exampleId === 'blank') {
      setName(example.id === 'blank' ? '' : example.name)
    }
  }

  const status = existing !== null ? describeBlockStatus(existing) : null
  const restartTitle = restartReason({
    existing,
    dirty,
    saving,
    restarting,
  })

  return (
    <div className="space-y-4">
      {status !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badgeVariantForTone(status.tone)}>{status.label}</Badge>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-foreground-subtle">{t('build.blockEditor.name', 'Name')}</span>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('build.blockEditor.whatThisScriptDoes', 'What this script does')}
          />
        </label>
        <label className="block text-sm">
          <span className="text-foreground-subtle">
            {t('build.blockEditor.integrationOptional', 'Integration (optional)')}
          </span>
          <Input
            className="mt-1"
            value={integrationId}
            onChange={(e) => setIntegrationId(e.target.value)}
            placeholder={t(
              'build.blockEditor.leaveEmptyForTheShared',
              'Leave empty for the shared system integration',
            )}
          />
        </label>
      </div>

      {existing === null && offerExamples && (
        <label className="block text-sm">
          <span className="text-foreground-subtle">
            {t('build.blockEditor.startFrom', 'Start from')}
          </span>
          <select
            className="mt-1 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm"
            value={exampleId}
            onChange={(e) => void applyExample(e.target.value)}
            data-testid="script-example-select"
          >
            {SCRIPT_EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.name} — {ex.description}
              </option>
            ))}
          </select>
        </label>
      )}

      <div>
        <NodePicker
          selectedNodeId={placement}
          onSelect={setPlacement}
          label={t('build.blockEditor.runsOn', 'Runs on')}
          alwaysShow
        />
        {placement !== HUB && (
          <p className="mt-2 flex items-start gap-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <Trans
                i18nKey="build.blockEditor.hubOnlyWarning"
                components={{ strong: <strong /> }}
              />
            </span>
          </p>
        )}
      </div>

      {/* Editor only here. Logs open UNDER the Logs button at the bottom —
            stacking them under the editor put them between code and settings
            on a tall page, so the operator clicked Logs and saw nothing near
            the control. */}
      <div className="flex min-h-[56vh] flex-col rounded border border-border">
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          {filePaths.map((path) =>
            renamingPath === path ? (
              <Input
                key={path}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitRename()
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setRenamingPath(null)
                  }
                }}
                className="h-7 w-36 px-2 py-0 text-xs"
                autoFocus
                data-testid="script-file-rename"
                aria-label={t('build.blockEditor.renameFile', 'Rename file')}
              />
            ) : (
              <button
                key={path}
                type="button"
                className={`rounded px-2 py-1 text-xs ${
                  path === activeFile
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-foreground-subtle hover:text-foreground'
                }`}
                onClick={() => setActiveFile(path)}
                onDoubleClick={() => beginRename(path)}
                title={t('build.blockEditor.doubleClickToRename', 'Double-click to rename')}
                data-testid={`script-file-tab-${path}`}
              >
                {path}
                {path === entry ? ` · ${t('build.blockEditor.entry')}` : ''}
              </button>
            ),
          )}
          <button
            type="button"
            className="ml-1 rounded px-2 py-1 text-xs text-foreground-subtle hover:text-foreground"
            onClick={addFile}
            data-testid="script-file-add"
          >
            {t('build.blockEditor.file', '+ file')}
          </button>
          {activeFile !== entry && (
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-foreground-subtle hover:text-foreground"
              onClick={() => setEntry(activeFile)}
              title={t('build.blockEditor.useThisFileAsThe', 'Use this file as the compile entry')}
            >
              {t('build.blockEditor.setAsEntry', 'Set as entry')}
            </button>
          )}
        </div>
        {typeDefsLoading ? (
          <p className="p-4 text-sm text-foreground-subtle">
            {t('build.blockEditor.loadingTheNodeSType', "Loading the node's type definitions…")}
          </p>
        ) : (
          <CodeEditor
            value={code}
            onChange={setCode}
            path={`file:///${activeFile}`}
            extraLibs={editorLibs}
            onDiagnostics={setDiagnostics}
            dark={resolvedMode === 'dark'}
            heightPx={560}
          />
        )}
      </div>

      {typeDefs !== undefined && typeDefs.libs.length === 0 && (
        // A "TypeScript editor" whose types failed to load looks exactly like
        // one that works — right up until `ctx.` autocompletes nothing and
        // every real error passes the gate silently.
        <p className="text-xs text-warning">
          {t(
            'build.blockEditor.theNodeReturnedNoType',
            "The node returned no type definitions, so this code is NOT being checked against the system's types. The server-side compile still applies on save.",
          )}
        </p>
      )}

      {errors.length > 0 && (
        <div className="space-y-1 rounded border border-danger/40 bg-danger/10 p-3 text-xs">
          <p className="font-medium text-danger">
            {t('build.blockEditor.errorsCannotSave', { count: errors.length })}
          </p>
          {errors.slice(0, 5).map((d) => (
            <p key={`${String(d.line)}:${String(d.column)}:${d.message}`} className="text-danger">
              {t('build.blockEditor.diagnosticLine', { line: d.line, message: d.message })}
            </p>
          ))}
          {errors.length > 5 && (
            <p className="text-foreground-subtle">
              {t('build.blockEditor.moreErrors', { count: errors.length - 5 })}
            </p>
          )}
        </div>
      )}

      {/* The server's own verdict, asked for without storing anything. */}
      {compile.data !== undefined &&
        (compile.data.ok ? (
          <p className="flex items-center gap-2 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> {t('build.blockEditor.compiledOk')}
          </p>
        ) : (
          <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
            {compile.data.line !== undefined && (
              <span className="mr-1">
                {t('build.blockEditor.errorLine', { line: String(compile.data.line) })}
              </span>
            )}
            {compile.data.error ??
              t('build.blockEditor.theCodeDoesNotCompile', 'the code does not compile')}
          </div>
        ))}
      {compile.error !== null && (
        <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {t('build.blockEditor.couldNotReachTheCompiler', 'Could not reach the compiler:')}{' '}
          {errorText(compile.error)}
        </div>
      )}

      {saveError !== null && (
        <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {saveError}
        </div>
      )}
      {restartError !== null && (
        <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          {restartError}
        </div>
      )}

      {existing !== null && (
        <div className="space-y-3">
          <ScriptSettingsPanel blockId={existing.id} />
          <ScriptDevicesPanel blockId={existing.id} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => compile.mutate()}
          disabled={compile.isPending || saving}
          title={t('build.blockEditor.typeCheckOnTheNode', 'Type-check on the node without saving')}
        >
          {compile.isPending && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.compile')}
        </Button>
        <Button onClick={save} disabled={saving || blocked || nameMissing}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save')}
        </Button>
        <Button
          variant="outline"
          onClick={() => onRestart?.()}
          disabled={restartTitle !== null || onRestart === undefined}
          title={
            restartTitle ??
            t(
              'build.blockEditor.stopTheProcessAndLet',
              'Stop the process and let the supervisor bring it back',
            )
          }
        >
          {restarting ? (
            <RotateCw className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}{' '}
          {t('build.blockEditor.restart', 'Restart')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setShowLogs(!showLogs)}
          title={t('build.blockEditor.showThisScriptSProcess', "Show this script's process logs")}
          data-testid="script-logs-toggle"
        >
          <ScrollText className="h-4 w-4" /> {t('common.logs')} {showLogs ? '▾' : '▸'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t('common.close', 'Close')}
        </Button>
        <span className="ml-auto text-xs text-foreground-subtle">
          {t('build.blockEditor.errorsCount', { count: errors.length })}
          {dirty && existing !== null ? ` · ${t('build.blockEditor.unsavedChanges')}` : ''}
        </span>
        {nameMissing && (
          <Badge variant="warning">{t('build.blockEditor.nameRequired', 'Name required')}</Badge>
        )}
      </div>

      {showLogs && (
        <div className="rounded border border-border" data-testid="script-logs-panel">
          <div className="border-b border-border px-3 py-1.5 text-xs text-foreground-subtle">
            {existing !== null ? (
              <>
                <Trans
                  i18nKey="build.blockEditor.logsOf"
                  values={{ id: coreBlockAddonId(existing.id) }}
                  components={{ code: <code /> }}
                />
              </>
            ) : (
              t(
                'build.blockEditor.logsAppearOnceTheScript',
                'Logs appear once the script has been saved and started.',
              )
            )}
          </div>
          {existing !== null && (
            <LogStream
              addonId={coreBlockAddonId(existing.id)}
              maxHeight="max-h-[560px]"
              showFilters={false}
            />
          )}
        </div>
      )}
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
