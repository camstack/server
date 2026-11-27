/**
 * `AddonScopedSettingsForm` — mounts one scope of one capability's settings
 * via `api.addonSettings.getScopedSettings` + `updateScopedSettings` and
 * renders it with `ConfigFormBuilder`. The schema is the capability's own
 * declaration — no hardcoded option lists anywhere in the UI.
 *
 * The caller passes the tRPC client + (addonId, cap, scope), and a `nodeId`
 * for the `node` scope; the component handles the fetch + patch loop.
 * `onAfterChange` fires once the patch is applied so consumers can re-read any
 * derived state.
 */
import { useUiText } from '../contexts/ui-text'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  type ConfigUISchemaWithValues,
  type ConfigUISchema,
  type ConfigFieldWithValue,
  type ScopedSettingsScope,
  dehydrateSchema,
} from '@camstack/types'
import { ConfigFormBuilder } from './config-form-builder.js'
import { FormSaveBar } from './form-save-bar.js'

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

interface AddonScopedSettingsFormTrpc {
  addonSettings: {
    getScopedSettings: {
      query: (input: {
        addonId: string
        cap: string
        scope: ScopedSettingsScope
        nodeId?: string
      }) => Promise<ConfigUISchemaWithValues | null>
    }
    updateScopedSettings: {
      mutate: (input: {
        addonId: string
        cap: string
        scope: ScopedSettingsScope
        nodeId?: string
        patch: Record<string, unknown>
      }) => Promise<unknown>
    }
  }
}

interface AddonScopedSettingsFormProps {
  readonly trpc: AddonScopedSettingsFormTrpc
  readonly addonId: string
  /** The capability whose settings of `scope` this form edits. */
  readonly cap: string
  readonly scope: ScopedSettingsScope
  /** The `node` scope's node; absent for `cluster` / `device`. */
  readonly nodeId?: string
  readonly title?: string
  /** Shown instead of the default "{{name}} not available." when the addon answers nothing. */
  readonly unavailableText?: string
  readonly disabled?: boolean
  readonly onAfterChange?: () => void
  /** Bump to force refetch (e.g. after an external mutation). */
  readonly refreshToken?: number
  /**
   * Render only these section ids of the scope's schema (e.g. System → Cluster
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
}

type ValueBearingField = Extract<ConfigFieldWithValue, { readonly value: unknown }>

/** Layout-only field types: they carry no value of their own. */
const VALUELESS_TYPES: ReadonlySet<string> = new Set([
  'separator',
  'info',
  'button',
  'group',
  'sub-tabs',
  'qr-code',
  'widget',
])

function isValueBearingField(f: ConfigFieldWithValue): f is ValueBearingField {
  return !VALUELESS_TYPES.has(f.type)
}

function extractValues(schema: ConfigUISchemaWithValues | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema) return out
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (!isValueBearingField(f)) continue
      out[f.key] = f.value
    }
  }
  return out
}

/** Structural equality for JSON-shaped field values (arrays and objects included). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function stripValues(schema: ConfigUISchemaWithValues): ConfigUISchema {
  return dehydrateSchema(schema)
}

export function AddonScopedSettingsForm({
  trpc,
  addonId,
  cap,
  scope,
  nodeId,
  title,
  unavailableText,
  disabled,
  onAfterChange,
  refreshToken,
  sectionIds,
  bare = false,
  collapsible,
  defaultOpen,
}: AddonScopedSettingsFormProps): JSX.Element | null {
  const t = useUiText()
  const [hydrated, setHydrated] = useState<ConfigUISchemaWithValues | null>(null)
  /** Operator edits not yet replaced by a server snapshot, so controlled inputs keep focus. */
  const [edits, setEdits] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Saved values the last re-read did not echo back (the addon was mid-restart). */
  const [committed, setCommitted] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false)
  /** Bumps on every persist edit; a stale refetch must not clobber a newer local paint. */
  const persistSeq = useRef(0)
  /** The target the hydrated view belongs to: another target must not inherit it. */
  const targetKey = `${addonId}\u0000${cap}\u0000${scope}\u0000${nodeId ?? ''}`
  const viewTargetKey = useRef(targetKey)
  const target = { addonId, cap, scope, ...(nodeId ? { nodeId } : {}) }

  useEffect(() => {
    let cancelled = false
    // A refetch of the SAME target keeps its last-known view (below); another target starts empty.
    if (viewTargetKey.current !== targetKey) {
      viewTargetKey.current = targetKey
      persistSeq.current++
      setHydrated(null)
      setEdits({})
      setCommitted({})
    }
    setLoading(true)
    setError(null)
    trpc.addonSettings.getScopedSettings
      .query({ addonId, cap, scope, ...(nodeId ? { nodeId } : {}) })
      .then((res) => {
        if (cancelled) return
        // `res` is null when the addon can't serve settings right now
        // (mid-restart). Keep the last-known schema rather than blanking the
        // form — a refreshToken-driven refetch must not clobber a good view
        // with a transient null. Initial load with no prior view stays null
        // (renders "not available") until the addon is ready.
        setHydrated((prev) => res ?? prev)
        if (res) {
          setEdits({})
          setCommitted({})
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
  }, [trpc, addonId, cap, scope, nodeId, refreshToken, targetKey])

  const values = useMemo(() => {
    const served = extractValues(hydrated)
    const painted: Record<string, unknown> = { ...served }
    for (const key of Object.keys(committed)) if (key in served) painted[key] = committed[key]
    for (const key of Object.keys(edits)) if (key in served) painted[key] = edits[key]
    return painted
  }, [hydrated, edits, committed])
  const sectionKey = sectionIds?.join('\u0000')
  const schemaNoValues = useMemo(() => {
    if (!hydrated) return null
    const stripped = stripValues(hydrated)
    if (sectionIds === undefined) return stripped
    const wanted = new Set(sectionIds)
    return {
      ...stripped,
      sections: stripped.sections.filter((s) => wanted.has(s.id)),
    }
    // `sectionKey` is the stable form of `sectionIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sectionKey])

  /** Keys whose draft differs from the served value: the one patch a Save sends. */
  const pendingPatch = useMemo(() => {
    const served = { ...extractValues(hydrated), ...committed }
    const patch: Record<string, unknown> = {}
    for (const key of Object.keys(edits)) {
      if (key in served && !sameValue(edits[key], served[key])) patch[key] = edits[key]
    }
    return patch
  }, [hydrated, edits, committed])
  const pendingCount = Object.keys(pendingPatch).length

  // The edit stays in the local draft until Save; nothing is written from a field.
  const handleChange = (nextValues: Record<string, unknown>) => {
    setEdits((prev) => ({ ...prev, ...nextValues }))
  }

  const handleDiscard = () => {
    setEdits({})
    setSaveError(null)
  }

  const handleSave = async () => {
    if (pendingCount === 0) return
    const seq = ++persistSeq.current
    setSaving(true)
    setSaveError(null)
    try {
      await trpc.addonSettings.updateScopedSettings.mutate({ ...target, patch: pendingPatch })
      // Re-fetch so derived fields (e.g. `probedBest*` hints refreshed by a
      // sibling action) stay in sync. A restart-causing change makes this
      // refetch race the restart window, where `getScopedSettings` returns
      // null: keep the previous view, the addon's state is already persisted.
      const next = await trpc.addonSettings.getScopedSettings.query(target)
      if (seq === persistSeq.current) {
        if (next) {
          setHydrated(next)
          setEdits({})
        } else {
          // Saved, but the re-read answered nothing: the patch is now the served state.
          setCommitted((prev) => ({ ...prev, ...pendingPatch }))
          setEdits({})
        }
        onAfterChange?.()
      }
    } catch (err: unknown) {
      // A failed save keeps the draft so the operator can retry or discard.
      if (seq === persistSeq.current) {
        setSaveError(err instanceof Error ? err.message : String(err))
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
      <div className="text-xs text-danger">
        {title ?? addonId}: {error}
      </div>
    )
  if (!hydrated || !schemaNoValues)
    return (
      <div className="text-xs text-foreground-subtle">
        {unavailableText ??
          t('uiLibrary.addonGlobalSettings.unavailable', '{{name}} not available.', {
            name: title ?? addonId,
          })}
      </div>
    )

  const body = (
    <>
      {saveError !== null ? (
        <div className="mb-2 text-xs text-danger" role="alert">
          {saveError}
        </div>
      ) : null}
      <ConfigFormBuilder
        schema={schemaNoValues}
        values={values}
        onChange={handleChange}
        disabled={disabled === true}
        bare={bare}
      />
      <FormSaveBar
        pendingCount={pendingCount}
        onSave={() => void handleSave()}
        onDiscard={handleDiscard}
        saving={saving}
      />
    </>
  )

  // Bare: never wrap in a titled card (collapsible ignored).
  if (bare) return <div>{body}</div>

  if (collapsible === true) {
    return (
      <section className="rounded-lg border border-border bg-surface overflow-hidden">
        <button // ui-check-ok: a full-width collapsible section header, not a push button
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
