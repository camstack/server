/**
 * Model selection for a `managed-local` profile.
 *
 * Three sources, one dropdown, because to the operator they are one question
 * ("which model does this profile run?"):
 *
 *   1. the curated catalog — pinned digest, checked RAM guidance;
 *   2. GGUFs already on the chosen node — including ones copied there by hand,
 *      which is why `LlmNodeModel.path` exists;
 *   3. anything on Hugging Face, typed into the field below.
 *
 * ## Why the Hugging Face box is two steps and not one
 *
 * "Check" resolves; "Download" installs. They are separate because resolution
 * is the only moment the operator can still say no — a GGUF repo publishes up
 * to 25 quantizations between 10 GB and 50 GB, plus a projector the reference
 * never mentioned, and the difference between them is tens of GB and whether
 * the node can load the result at all. So the preview states the size, the
 * quantization and every companion file BEFORE a byte moves, and a repo with
 * more than one candidate comes back as a refusal with the tags listed — each
 * one a chip that fills the field back in.
 */
import type {
  HfModelResolution,
  LlmNodeModel,
  LlmRuntimeNode,
  ManagedModelCatalogEntry,
  ManagedModelRef,
} from '@camstack/types'
import { Badge, Button, ErrorBox, FormField, Input, Select, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, Loader2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CATALOG_KEY, RUNTIME_NODES_KEY } from './ai-page.helpers'
import i18n from '../../i18n/index'

const DOWNLOAD_POLL_MS = 2_000

export interface ModelChoice {
  readonly model: ManagedModelRef
  readonly modelId: string
  readonly supportsVision: boolean
}

export interface AiModelPickerProps {
  readonly nodeId: string
  readonly value: ModelChoice | null
  readonly onChange: (choice: ModelChoice | null) => void
}

export function gbOf(bytes: number): string {
  return i18n.t('system.aiModelPicker.sizeGb', { value: (bytes / 1_000_000_000).toFixed(2) })
}

/** `catalog:<id>` / `node:<file>` / `custom` — the dropdown's flat value space. */
function optionValueFor(choice: ModelChoice | null): string {
  if (choice === null) return ''
  if (choice.model.kind === 'catalog') return `catalog:${choice.model.catalogId}`
  if (choice.model.kind === 'path') return `node:${choice.modelId}`
  return 'custom'
}

export function AiModelPicker({ nodeId, value, onChange }: AiModelPickerProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [reference, setReference] = useState('')
  const [resolution, setResolution] = useState<HfModelResolution | null>(null)
  const [installed, setInstalled] = useState(false)

  const catalogQuery = useQuery({
    queryKey: CATALOG_KEY,
    queryFn: (): Promise<readonly ManagedModelCatalogEntry[]> =>
      system.trpcClient.llm.listModelCatalog.query({}),
  })

  const nodeModelsQuery = useQuery({
    queryKey: ['llm', 'listNodeModels', nodeId],
    queryFn: (): Promise<readonly LlmNodeModel[]> =>
      system.trpcClient.llm.listNodeModels.query({ nodeId }),
  })

  const resolveMutation = useMutation({
    mutationFn: (input: { ref: string; maxBytes?: number }): Promise<HfModelResolution> =>
      system.trpcClient.llm.resolveModelRef.mutate(input),
    onSuccess: (result) => {
      setResolution(result)
      setInstalled(false)
      if (result.ok) {
        onChange({
          model: result.model,
          modelId: result.label,
          supportsVision: result.purpose === 'vision',
        })
      }
    },
  })

  const installMutation = useMutation({
    mutationFn: (model: ManagedModelRef): Promise<void> =>
      system.trpcClient.llm.installModel.mutate({ nodeId, model }),
    onSuccess: () => {
      setInstalled(true)
      void nodeModelsQuery.refetch()
    },
  })

  // Poll the node ONLY while an install is in flight — a multi-GB download
  // that reports nothing is indistinguishable from a hung node.
  const statusQuery = useQuery({
    queryKey: RUNTIME_NODES_KEY,
    enabled: installMutation.isPending,
    refetchInterval: installMutation.isPending ? DOWNLOAD_POLL_MS : false,
    queryFn: (): Promise<readonly LlmRuntimeNode[]> =>
      system.trpcClient.llm.listRuntimeNodes.query({}),
  })
  const download = statusQuery.data?.find((n) => n.nodeId === nodeId)?.status?.download

  const options = useMemo(() => {
    const catalogEntries = (catalogQuery.data ?? []).map((entry) => ({
      value: `catalog:${entry.id}`,
      label: `${entry.label} · ${entry.quantization} · ${gbOf(entry.sizeBytes)}`,
    }))
    // Only files the catalog does NOT already account for — otherwise the same
    // model appears twice with two different ways to select it.
    const nodeEntries = (nodeModelsQuery.data ?? [])
      .filter((m) => m.catalogId === undefined && m.path !== undefined)
      .map((m) => ({
        value: `node:${m.file}`,
        label: t('ai.onNode', '{{file}} · {{size}} · on {{node}}', {
          file: m.file,
          size: gbOf(m.sizeBytes),
          node: nodeId,
        }),
      }))
    const custom =
      resolution?.ok === true
        ? [{ value: 'custom', label: `${resolution.label} · ${gbOf(resolution.totalBytes)}` }]
        : []
    return [
      { value: '', label: t('ai.selectModel', 'Select a model…') },
      ...catalogEntries,
      ...nodeEntries,
      ...custom,
    ]
  }, [catalogQuery.data, nodeModelsQuery.data, resolution, nodeId, t])

  const pick = (optionValue: string): void => {
    if (optionValue === '') {
      onChange(null)
      return
    }
    if (optionValue === 'custom') {
      if (resolution?.ok !== true) return
      onChange({
        model: resolution.model,
        modelId: resolution.label,
        supportsVision: resolution.purpose === 'vision',
      })
      return
    }
    if (optionValue.startsWith('catalog:')) {
      const catalogId = optionValue.slice('catalog:'.length)
      const entry = catalogQuery.data?.find((e) => e.id === catalogId)
      onChange({
        model: { kind: 'catalog', catalogId },
        modelId: catalogId,
        supportsVision: entry?.purpose === 'vision',
      })
      return
    }
    const file = optionValue.slice('node:'.length)
    const nodeModel = nodeModelsQuery.data?.find((m) => m.file === file)
    if (nodeModel?.path === undefined) return
    // A hand-placed file tells us nothing about vision: the operator sets that
    // switch themselves rather than have it guessed from a filename.
    onChange({
      model: { kind: 'path', path: nodeModel.path },
      modelId: file,
      supportsVision: false,
    })
  }

  const check = (maxBytes?: number): void => {
    if (reference.trim() === '') return
    resolveMutation.mutate({
      ref: reference.trim(),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    })
  }

  return (
    <div className="space-y-3">
      <FormField label={t('ai.model', 'Model')} required>
        <Select
          id="ai-model"
          aria-label={t('ai.model', 'Model')}
          value={optionValueFor(value)}
          options={options}
          onChange={(e) => pick(e.target.value)}
        />
      </FormField>

      <FormField
        label={t('ai.hfTitle', 'Add a model from Hugging Face')}
        description={t(
          'ai.hfHint',
          'Paste a GGUF file URL, or type org/repo — add :QUANT (e.g. unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M) when the repo publishes more than one quantization.',
        )}
      >
        <div className="flex gap-2">
          <Input
            aria-label={t('ai.hfTitle', 'Add a model from Hugging Face')}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t(
              'system.aiModelPicker.unslothQwen3635bA3b',
              'unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M',
            )}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                check()
              }
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            type="button"
            disabled={reference.trim() === '' || resolveMutation.isPending}
            onClick={() => check()}
          >
            {resolveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {t('ai.hfCheck', 'Check')}
          </Button>
        </div>
      </FormField>

      {resolveMutation.isError && (
        <ErrorBox
          message={
            resolveMutation.error instanceof Error
              ? resolveMutation.error.message
              : t('common.error', 'Error')
          }
        />
      )}

      {resolution?.ok === false && (
        <ErrorBox
          message={resolution.message}
          action={
            <div className="flex flex-wrap items-center gap-1">
              {(resolution.candidates ?? []).map((tag) => (
                <Button
                  key={tag}
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => {
                    const repo = reference.trim().split(':')[0] ?? ''
                    const next = `${repo}:${tag}`
                    setReference(next)
                    resolveMutation.mutate({ ref: next })
                  }}
                >
                  {tag}
                </Button>
              ))}
              {resolution.requiredBytes !== undefined && (
                <Button
                  size="sm"
                  variant="secondary"
                  type="button"
                  onClick={() => check(resolution.requiredBytes)}
                >
                  {t('ai.hfOverride', 'Install anyway ({{size}})', {
                    size: gbOf(resolution.requiredBytes),
                  })}
                </Button>
              )}
            </div>
          }
        />
      )}

      {resolution?.ok === true && (
        <div className="space-y-2 rounded-md border border-border bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-foreground">{resolution.label}</span>
            <Badge variant={resolution.purpose === 'vision' ? 'info' : 'default'}>
              {resolution.purpose}
            </Badge>
            <Badge variant="default">{gbOf(resolution.totalBytes)}</Badge>
          </div>
          {resolution.extraFilenames.length > 0 && (
            <p className="text-[10px] text-foreground-subtle">
              {t('ai.hfExtras', 'Also downloads: {{files}}', {
                files: resolution.extraFilenames.join(', '),
              })}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              disabled={installMutation.isPending || installed}
              onClick={() => installMutation.mutate(resolution.model)}
            >
              {installMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {installed
                ? t('ai.hfInstalled', 'Downloaded')
                : t('ai.hfInstall', 'Download to {{node}}', { node: nodeId })}
            </Button>
            {download !== undefined && (
              <span className="text-[10px] text-foreground-subtle">
                {download.phase === 'verifying'
                  ? t('ai.hfVerifying', 'verifying {{file}}…', { file: download.file })
                  : t('ai.hfDownloading', '{{file}} ({{index}}/{{count}}) — {{done}}{{total}}', {
                      file: download.file,
                      index: download.fileIndex,
                      count: download.fileCount,
                      done: gbOf(download.downloadedBytes),
                      total:
                        download.totalBytes !== undefined ? ` / ${gbOf(download.totalBytes)}` : '',
                    })}
              </span>
            )}
          </div>
          {installMutation.isError && (
            <ErrorBox
              message={
                installMutation.error instanceof Error
                  ? installMutation.error.message
                  : t('common.error', 'Error')
              }
            />
          )}
        </div>
      )}
    </div>
  )
}
