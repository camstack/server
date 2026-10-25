/**
 * `AddonGlobalSettingsForm` — mounts an addon's global-settings schema
 * via `api.addonSettings.getGlobalSettings` + `updateGlobalSettings`
 * and renders it with `ConfigFormBuilder`. Single source of truth for
 * the addon's settings — no hardcoded option lists anywhere in the UI.
 *
 * Used wherever an addon's settings need to be edited inline (e.g.
 * benchmark tabs, per-node pipeline editor). The caller passes the
 * tRPC client + (addonId, nodeId); the component handles the fetch
 * + patch loop. `onAfterChange` fires once the patch is applied so
 * consumers can re-read any derived state.
 */
import { useUiText } from '../contexts/ui-text'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  type ConfigUISchemaWithValues,
  type ConfigUISchema,
  type ConfigField,
  dehydrateSchema,
} from '@camstack/types'
import { ConfigFormBuilder } from './config-form-builder.js'

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

interface AddonGlobalSettingsFormTrpc {
  addonSettings: {
    getGlobalSettings: {
      query: (input: {
        addonId: string
        nodeId?: string
        overlay?: Record<string, unknown>
      }) => Promise<ConfigUISchemaWithValues | null>
    }
    updateGlobalSettings: {
      mutate: (input: {
        addonId: string
        nodeId?: string
        patch: Record<string, unknown>
      }) => Promise<unknown>
    }
  }
}

interface AddonGlobalSettingsFormProps {
  readonly trpc: AddonGlobalSettingsFormTrpc
  readonly addonId: string
  readonly nodeId: string
  readonly title?: string
  readonly disabled?: boolean
  readonly onAfterChange?: () => void
  /** Bump to force refetch (e.g. after an external mutation). */
  readonly refreshToken?: number
  /**
   * Render only these section ids of the addon's schema (e.g. System → Cluster
   * draws the `system-config` cluster section alone). Absent → every section.
   */
  readonly sectionIds?: readonly string[]
  /**
   * Fields only — no form card, section border or section title. Use when the
   * parent already owns the layout (e.g. a page that frames the form itself).
   */
  readonly bare?: boolean
  /**
   * Render as collapsible. When true, the form body is hidden until
   * the operator expands the header (click). Defaults to open so
   * callers that always want the form visible don't have to opt out.
   */
  readonly collapsible?: boolean
  /** When `collapsible`, start expanded (true) or collapsed (false). Defaults to false. */
  readonly defaultOpen?: boolean
  /**
   * - `'persist'` (default): edits call `updateGlobalSettings` and
   *   re-fetch — the live store is mutated. Use in settings editors
   *   (NodePipelineTab, device details).
   * - `'override'`: edits stay local (never touch the store).
   *   `onOverrideChange` receives the current override values on
   *   every edit so the caller can pass them to a per-run action.
   *   Use in the benchmark tabs — operator tweaks for a single
   *   bench run without mutating the addon's saved settings.
   */
  readonly mode?: 'persist' | 'override'
  /**
   * Called on every edit when `mode: 'override'`. `patch` is the sparse
   * diff vs the persisted baseline (only the fields the operator touched).
   * `effective` is the baseline merged with the patch — every field a
   * downstream action might need, with the operator's override applied.
   * Callers that need to emit a full engine triple (runtime+backend+format)
   * should read from `effective`, not `patch`, so partial edits (e.g.
   * operator tweaks only `device`) still produce a complete payload.
   */
  readonly onOverrideChange?: (
    patch: Record<string, unknown>,
    effective: Record<string, unknown>,
  ) => void
}

function isValueBearingField(f: ConfigField): boolean {
  return f.type !== 'separator' && f.type !== 'info' && f.type !== 'button' && f.type !== 'group'
}

function extractValues(schema: ConfigUISchemaWithValues | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema) return out
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (!isValueBearingField(f)) continue
      const key = (f as { readonly key: string }).key
      out[key] = (f as { readonly value?: unknown }).value
    }
  }
  return out
}

/** Paint operator edits into the hydrated schema so controlled inputs keep focus. */
function applyValuesToSchema(
  schema: ConfigUISchemaWithValues,
  nextValues: Record<string, unknown>,
): ConfigUISchemaWithValues {
  return {
    ...schema,
    sections: schema.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        if (!isValueBearingField(f)) return f
        const key = (f as { readonly key: string }).key
        if (!(key in nextValues)) return f
        return { ...f, value: nextValues[key] } as typeof f
      }),
    })),
  }
}

function stripValues(schema: ConfigUISchemaWithValues): ConfigUISchema {
  return dehydrateSchema(schema)
}

export function AddonGlobalSettingsForm({
  trpc,
  addonId,
  nodeId,
  title,
  disabled,
  onAfterChange,
  refreshToken,
  sectionIds,
  bare = false,
  collapsible,
  defaultOpen,
  mode,
  onOverrideChange,
}: AddonGlobalSettingsFormProps): JSX.Element | null {
  const t = useUiText()
  const effectiveMode = mode ?? 'persist'
  const [hydrated, setHydrated] = useState<ConfigUISchemaWithValues | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false)
  const [overrideValues, setOverrideValues] = useState<Record<string, unknown>>({})
  // Snapshot of the addon's *persisted* values, captured once on first
  // hydrate. The patch diff must reference this stable baseline, not the
  // overlay-hydrated `values` — otherwise each overlay refetch shifts the
  // baseline and the user's earlier override fields silently drop out of
  // the emitted patch (e.g. setting runtime=python then backend=coreml
  // would lose `engineRuntime` from the patch).
  const [baseValues, setBaseValues] = useState<Record<string, unknown> | null>(null)
  /** Bumps on every persist edit; a stale refetch must not clobber a newer local paint. */
  const persistSeq = useRef(0)

  // Reset baseline + override when the target addon / node / mode changes
  // or the caller bumps refreshToken. Keeps the snapshot stable across
  // overlay-triggered refetches within a single editing session.
  useEffect(() => {
    setBaseValues(null)
    setOverrideValues({})
  }, [trpc, addonId, nodeId, refreshToken, effectiveMode])

  const overlayKey = JSON.stringify(overrideValues)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Pass the current override patch as a preview overlay so the
    // backend's dynamic-option logic (e.g. detection-pipeline's
    // `engineRuntime → engineBackend → engineDevice` cascade) derives
    // the next level's options against the operator's tentative
    // choice. Persist mode has overrideValues={} so this is a no-op.
    const overlay =
      effectiveMode === 'override' && Object.keys(overrideValues).length > 0
        ? overrideValues
        : undefined
    trpc.addonSettings.getGlobalSettings
      .query({ addonId, nodeId, ...(overlay ? { overlay } : {}) })
      .then((res) => {
        if (cancelled) return
        // `res` is null when the addon can't serve settings right now
        // (mid-restart). Keep the last-known schema rather than blanking the
        // form — a refreshToken-driven refetch must not clobber a good view
        // with a transient null. Initial load with no prior view stays null
        // (renders "not available") until the addon is ready.
        setHydrated((prev) => res ?? prev)
        // Capture the baseline only on the first hydrate of this editing
        // session — overlay-driven refetches must not shift it.
        if (!overlay && res) {
          setBaseValues(extractValues(res))
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `overlayKey` is the JSON of `overrideValues` — re-fetches when
    // the operator tweaks an upstream cascade field; `effectiveMode`
    // toggles overlay passthrough. Left `overrideValues` itself out
    // of deps on purpose (it's object-identity-unstable; the stable
    // string form is the signal).
  }, [trpc, addonId, nodeId, refreshToken, effectiveMode, overlayKey])

  const values = useMemo(() => extractValues(hydrated), [hydrated])
  const sectionKey = sectionIds?.join('\u0000')
  const schemaNoValues = useMemo(() => {
    if (!hydrated) return null
    const stripped = stripValues(hydrated)
    if (sectionIds === undefined) return stripped
    const wanted = new Set(sectionIds)
    return { ...stripped, sections: stripped.sections.filter((s) => wanted.has(s.id)) }
    // `sectionKey` is the stable form of `sectionIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sectionKey])

  const handleChange = async (nextValues: Record<string, unknown>) => {
    if (effectiveMode === 'override') {
      // Override mode — NEVER touch the addon's persisted store.
      // Diff against the *stable* baseline so previously-set override
      // fields stay in the emitted patch across overlay refetches.
      const ref = baseValues ?? values
      const patch: Record<string, unknown> = {}
      for (const k of Object.keys(nextValues)) {
        if (nextValues[k] !== ref[k]) patch[k] = nextValues[k]
      }
      // Effective = baseline merged with patch. Callers that need a
      // full field set (e.g. engine runtime+backend+format triple for
      // the benchmark's per-run override) must read this instead of the
      // sparse patch — otherwise touching only one field loses the
      // baseline context and the override emits incomplete payloads.
      const effective: Record<string, unknown> = { ...ref, ...patch }
      setOverrideValues(patch)
      onOverrideChange?.(patch, effective)
      return
    }
    // Build a minimal patch — only keys whose value differs from the
    // current hydrated snapshot. Keeps unrelated fields out of the
    // persisted store and lets the addon's `maybeAutoRestart` logic
    // only fire on real changes.
    const patch: Record<string, unknown> = {}
    for (const k of Object.keys(nextValues)) {
      if (nextValues[k] !== values[k]) patch[k] = nextValues[k]
    }
    if (Object.keys(patch).length === 0) return
    // Paint locally first and keep inputs enabled — disabling on save blurs
    // the focused field (mobile keyboard closes) on every keystroke.
    const seq = ++persistSeq.current
    setHydrated((prev) => (prev === null ? prev : applyValuesToSchema(prev, nextValues)))
    setSaving(true)
    setError(null)
    try {
      await trpc.addonSettings.updateGlobalSettings.mutate({ addonId, nodeId, patch })
      // Re-fetch so derived fields (e.g. `probedBest*` hints refreshed
      // by a sibling action) stay in sync. A change that restarts the addon
      // (engine cascade) makes this refetch race the restart window, where
      // `getGlobalSettings` returns null ("unavailable — keep last-known").
      // Never overwrite a good hydrated schema with null, or the form would
      // flash empty / reset its selection. Keep the previous view; the
      // addon's own state is already persisted server-side.
      // A newer keystroke bumps `persistSeq` — discard this refetch so it
      // cannot rewind the optimistic paint mid-edit.
      const next = await trpc.addonSettings.getGlobalSettings.query({ addonId, nodeId })
      if (next && seq === persistSeq.current) setHydrated(next)
      if (seq === persistSeq.current) onAfterChange?.()
    } catch (err: unknown) {
      if (seq === persistSeq.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (seq === persistSeq.current) setSaving(false)
    }
  }

  if (loading)
    return (
      <div className="text-xs text-foreground-subtle animate-pulse">
        {t('uiLibrary.addonGlobalSettings.loading', 'Loading {{name}}…', {
          name: title ?? addonId,
        })}
      </div>
    )
  if (error)
    return (
      <div className="text-xs text-red-400">
        {title ?? addonId}: {error}
      </div>
    )
  if (!hydrated || !schemaNoValues)
    return (
      <div className="text-xs text-foreground-subtle">
        {t('uiLibrary.addonGlobalSettings.unavailable', '{{name}} not available on {{node}}.', {
          name: title ?? addonId,
          node: nodeId,
        })}
      </div>
    )

  // In override mode the form renders (base ⊕ override) so the operator
  // always sees the effective value. In persist mode the form renders
  // the live store values.
  const effectiveValues = effectiveMode === 'override' ? { ...values, ...overrideValues } : values

  const body = (
    <>
      {effectiveMode === 'override' ? (
        <div className="mb-2 text-[11px] text-foreground-subtle">
          {t(
            'uiLibrary.addonGlobalSettings.override',
            "Benchmark override — applies to this run only. The addon's saved settings are not changed.",
          )}
        </div>
      ) : null}
      {saving ? (
        <div className="mb-2 text-[11px] text-foreground-subtle" aria-live="polite">
          {t('uiLibrary.addonGlobalSettings.saving', 'Saving…')}
        </div>
      ) : null}
      <ConfigFormBuilder
        schema={schemaNoValues}
        values={effectiveValues}
        onChange={handleChange}
        disabled={disabled === true}
        bare={bare}
      />
    </>
  )

  // Bare: never wrap in a titled card (collapsible ignored).
  if (bare) return <div>{body}</div>

  if (collapsible === true) {
    return (
      <section className="rounded-lg border border-border bg-surface overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full px-4 py-2 flex items-center gap-2 hover:bg-surface-hover text-left"
          aria-expanded={open}
        >
          <Chevron open={open} />
          <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide flex-1">
            {title ?? addonId}
          </h3>
          <span className="text-[10px] text-foreground-subtle">
            {open
              ? t('uiLibrary.addonGlobalSettingsForm.hide', 'hide')
              : t('uiLibrary.addonGlobalSettingsForm.edit', 'edit')}
          </span>
        </button>
        {open ? <div className="border-t border-border px-4 py-3">{body}</div> : null}
      </section>
    )
  }

  // No title + not collapsible → render body only. The parent owns the
  // visual wrapper (card, section header, etc.) to avoid the "bordered
  // panel nested inside another bordered panel" pattern.
  if (!title) return <div>{body}</div>

  return (
    <section className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2">
        <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">{title}</h3>
      </div>
      <div className="px-4 py-3">{body}</div>
    </section>
  )
}
