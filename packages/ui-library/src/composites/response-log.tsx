import { useUiText } from '../contexts/ui-text'
import { useState, type JSX } from 'react'

export interface ResponseLogProps {
  readonly data: unknown
  readonly label?: string
  readonly className?: string
}

/**
 * Expandable log box showing the raw JSON response from a pipeline run.
 */
export function ResponseLog({
  data,
  label = 'Response',
  className = '',
}: ResponseLogProps): JSX.Element | null {
  const t = useUiText()
  const [expanded, setExpanded] = useState(false)

  if (!data) return null

  const json = JSON.stringify(data, null, 2)

  return (
    <div className={`rounded-xl border border-border bg-surface overflow-hidden ${className}`}>
      <div
        className="px-3 py-2 border-b border-border flex items-center justify-between cursor-pointer select-none hover:bg-surface-hover/30"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-foreground-subtle">{expanded ? '▼' : '▶'}</span>
          <h3 className="text-xs font-medium text-foreground">{label}</h3>
        </div>
        <span className="text-[10px] text-foreground-subtle font-mono">
          {json.length > 1000
            ? t('uiLibrary.responseLog.kb', '{{size}} KB', {
                size: (json.length / 1024).toFixed(1),
              })
            : t('uiLibrary.responseLog.bytes', '{{count}} bytes', { count: json.length })}
        </span>
      </div>
      {expanded && (
        <div className="max-h-80 overflow-y-auto overflow-x-auto">
          <pre className="p-3 text-[10px] leading-4 font-mono text-foreground-subtle whitespace-pre">
            {json}
          </pre>
        </div>
      )}
    </div>
  )
}
