/**
 * WHERE an `apple-foundation` profile runs — the only thing that kind has to
 * configure.
 *
 * Every node running the ai addon is listed with its Apple Foundation Models
 * state, and only one that REPORTED `available` can be picked. The others are
 * shown, disabled, with the reason to act on ("Apple Intelligence off", "model
 * downloading") — and a node that did not answer says `unknown`, never "not
 * available" (D315). A node already saved on the profile stays selected even
 * when it is not available right now, so reopening a profile never silently
 * rewrites where it runs.
 */
import type { LlmRuntimeNode } from '@camstack/types'
import { Badge, useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { describeAppleNode, RUNTIME_NODES_KEY } from './ai-page.helpers'

interface AppleNodePickerProps {
  readonly value: string | null
  readonly onChange: (nodeId: string) => void
}

export function AppleNodePicker({ value, onChange }: AppleNodePickerProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const nodesQuery = useQuery({
    queryKey: RUNTIME_NODES_KEY,
    queryFn: (): Promise<readonly LlmRuntimeNode[]> =>
      system.trpcClient.llm.listRuntimeNodes.query({}),
  })

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-foreground">
        {t('ai.appleNode', 'Mac that runs it')}
      </div>
      {nodesQuery.isPending && (
        <div className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('ai.appleAsking', 'Asking the nodes…')}
        </div>
      )}
      {nodesQuery.isError && (
        <p className="text-[11px] text-danger">
          {nodesQuery.error instanceof Error
            ? nodesQuery.error.message
            : t('ai.runtimesFailed', 'Failed to read runtime nodes')}
        </p>
      )}
      {nodesQuery.isSuccess && nodesQuery.data.length === 0 && (
        <p className="text-[11px] text-foreground-subtle">
          {t('ai.noRuntimes', 'No node advertises the llm-runtime capability.')}
        </p>
      )}
      {nodesQuery.isSuccess && nodesQuery.data.length > 0 && (
        <div role="radiogroup" className="space-y-1.5">
          {nodesQuery.data.map((node) => {
            const view = describeAppleNode(node)
            const selected = view.nodeId === value
            return (
              <button
                key={view.nodeId}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!view.selectable && !selected}
                onClick={() => onChange(view.nodeId)}
                className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-surface hover:bg-surface-hover'
                }`}
              >
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{view.nodeId}</span>
                  {view.detail !== null && (
                    <span className="block truncate text-[10px] text-foreground-subtle">
                      {view.detail}
                    </span>
                  )}
                </span>
                <Badge variant={view.tone}>{t(view.labelKey, view.labelDefault)}</Badge>
              </button>
            )
          })}
        </div>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-foreground-subtle">
        {t(
          'ai.appleHint',
          'Text only for now — notification titles and summaries. Apple refuses prompts framed as surveillance; when it does, the next profile in the chain answers instead.',
        )}
      </p>
    </div>
  )
}
