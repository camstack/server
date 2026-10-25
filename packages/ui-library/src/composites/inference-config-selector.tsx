import { useUiText } from '../contexts/ui-text'
import { type JSX } from 'react'
/**
 * InferenceConfigSelector — cascading selectors for runtime/backend/model.
 *
 * Used by benchmark Engine tab, Image Tester pipeline steps, and admin-ui
 * pipeline configuration. Shows only valid combinations based on capabilities.
 */

export interface InferenceBackendOption {
  readonly id: string
  readonly label: string
  readonly available: boolean
}

export interface InferenceModelOption {
  readonly id: string
  readonly name: string
  readonly downloaded?: boolean
}

export interface InferenceAgentOption {
  readonly id: string
  readonly name: string
  readonly status: 'online' | 'offline' | 'busy'
}

export interface InferenceConfigSelectorProps {
  // Values
  readonly runtime: 'python'
  readonly backend: string
  readonly modelId: string
  readonly agentId?: string

  // Options
  readonly runtimes: readonly { value: string; label: string; available: boolean }[]
  readonly backends: readonly InferenceBackendOption[]
  readonly models: readonly InferenceModelOption[]
  readonly agents?: readonly InferenceAgentOption[]

  // Callbacks
  readonly onRuntimeChange: (rt: 'python') => void
  readonly onBackendChange: (id: string) => void
  readonly onModelChange: (id: string) => void
  readonly onAgentChange?: (id: string) => void

  // Layout
  readonly layout?: 'horizontal' | 'vertical' | 'grid'
  readonly className?: string
  /** Show agent selector (default: false) */
  readonly showAgent?: boolean
}

const SELECT_CLASS =
  'w-full px-3 py-2 text-sm rounded-md border border-border bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50'

export function InferenceConfigSelector({
  runtime,
  backend,
  modelId,
  agentId = 'hub',
  runtimes,
  backends,
  models,
  agents = [],
  onRuntimeChange,
  onBackendChange,
  onModelChange,
  onAgentChange,
  layout = 'grid',
  className,
  showAgent = false,
}: InferenceConfigSelectorProps): JSX.Element {
  const t = useUiText()
  const containerClass =
    layout === 'grid'
      ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4'
      : layout === 'horizontal'
        ? 'flex flex-wrap items-end gap-4'
        : 'space-y-3'

  return (
    <div className={`${containerClass} ${className ?? ''}`}>
      {/* Agent (optional) */}
      {showAgent && agents.length > 0 && (
        <label className="space-y-1">
          <span className="text-xs font-medium text-foreground-subtle">
            {t('uiLibrary.inferenceConfig.agent', 'Agent')}
          </span>
          <select
            value={agentId}
            onChange={(e) => onAgentChange?.(e.target.value)}
            className={SELECT_CLASS}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.status})
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Runtime */}
      <label className="space-y-1">
        <span className="text-xs font-medium text-foreground-subtle">
          {t('uiLibrary.inferenceConfig.runtime', 'Runtime')}
        </span>
        <select
          value={runtime}
          onChange={(e) => {
            if (e.target.value === 'python') onRuntimeChange('python')
          }}
          className={SELECT_CLASS}
        >
          {runtimes.map((r) => (
            <option key={r.value} value={r.value} disabled={!r.available}>
              {r.available
                ? r.label
                : t('uiLibrary.inferenceConfig.unavailable', '{{label}} (unavailable)', {
                    label: r.label,
                  })}
            </option>
          ))}
        </select>
      </label>

      {/* Backend */}
      <label className="space-y-1">
        <span className="text-xs font-medium text-foreground-subtle">
          {t('uiLibrary.inferenceConfig.backend', 'Backend')}
        </span>
        <select
          value={backend}
          onChange={(e) => onBackendChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {backends.map((b) => (
            <option key={b.id} value={b.id} disabled={!b.available}>
              {b.available
                ? b.label
                : t('uiLibrary.inferenceConfig.unavailable', '{{label}} (unavailable)', {
                    label: b.label,
                  })}
            </option>
          ))}
        </select>
      </label>

      {/* Model */}
      <label className="space-y-1">
        <span className="text-xs font-medium text-foreground-subtle">
          {t('uiLibrary.inferenceConfig.model', 'Model')}
        </span>
        <select
          value={modelId}
          onChange={(e) => onModelChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {models.length === 0 ? (
            <option value="">
              {t('uiLibrary.inferenceConfig.noModels', 'No compatible models')}
            </option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.downloaded ? ' ✓' : ''}
              </option>
            ))
          )}
        </select>
      </label>
    </div>
  )
}
