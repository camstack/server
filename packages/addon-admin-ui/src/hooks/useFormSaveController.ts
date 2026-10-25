import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import type { ConfigUISchemaWithValues, ConfigSection } from '@camstack/types'

/**
 * Determines whether a field should auto-save on change.
 *
 * Priority:
 *   1. No-value control fields (button / separator / info) → always immediate
 *      (they have no "pending edit" semantics — the action fires on click).
 *   2. Field-level `immediate: true/false` (explicit override).
 *   3. Section-level `immediate: true` (every field in the section auto-saves).
 *   4. Default: deferred — the change accumulates in the pending-edits overlay
 *      and is flushed via the Save button.
 *
 * NOTE: earlier versions auto-saved boolean / select / multiselect fields as a
 * structural default. That shortcut is intentionally removed — immediate
 * behaviour must now be declared explicitly by the addon author (per-field or
 * per-section), so every typing-surface field is part of the same "edit →
 * review → save" flow regardless of widget type.
 */
export function isImmediateField(
  sections: ReadonlyArray<Pick<ConfigSection, 'fields' | 'immediate'>>,
  key: string,
): boolean {
  for (const section of sections) {
    for (const f of section.fields) {
      if (!('key' in f) || f.key !== key) continue
      // No-value control fields — always immediate.
      if (f.type === 'button' || f.type === 'separator' || f.type === 'info') return true
      // Per-field explicit flag.
      const fieldImmediate = (f as { immediate?: boolean }).immediate
      if (fieldImmediate === true) return true
      if (fieldImmediate === false) return false
      // Section-level flag.
      if (section.immediate === true) return true
      // Default: deferred.
      return false
    }
  }
  return false
}

// ── Hook ────────────────────────────────────────────────────────────

export interface FormSaveControllerOptions {
  /** The current schema (used to determine which fields are immediate). */
  readonly schema: ConfigUISchemaWithValues | null
  /** Server-authoritative values (from the latest query). */
  readonly serverValues: Record<string, unknown>
  /** Fire an immediate save for these key→value pairs. */
  readonly onImmediateSave: (patch: Record<string, unknown>) => void
  /**
   * Fire a deferred save for these key→value pairs.
   *
   * **Return a promise that settles when the write has LANDED and the server
   * has been re-read**, and the edited values stay on screen until then. A
   * caller that returns nothing cannot be waited on, so the overlay clears
   * immediately, exactly as it always did — that is the `AddonFormPane` case,
   * where the parent owns the flush.
   */
  readonly onDeferredSave: (patch: Record<string, unknown>) => void | Promise<unknown>
}

export interface FormSaveController {
  /** The effective values (server values overlaid with pending edits). */
  readonly values: Record<string, unknown>
  /** Keys currently in the pending-edit overlay (not yet saved). */
  readonly pendingKeys: readonly string[]
  /** Whether there are any unsaved deferred edits. */
  readonly hasPendingEdits: boolean
  /** Whether polling should be paused (user is actively editing). */
  readonly editingPaused: boolean
  /** Called by FormBuilder on every field change. */
  readonly handleChange: (next: Record<string, unknown>) => void
  /** Save specific pending keys. */
  readonly handleSave: (keys: readonly string[]) => void
  /** Discard specific pending keys. */
  readonly handleDiscard: (keys: readonly string[]) => void
  /** Discard all pending edits. */
  readonly resetAll: () => void
}

/**
 * Shared form save controller used by both DeviceAggregateSection and
 * NodeAddonsSettingsPanel.
 *
 * Manages the pendingEdits overlay, immediate vs deferred save routing,
 * and polling pause during active editing.
 */
export function useFormSaveController({
  schema,
  serverValues,
  onImmediateSave,
  onDeferredSave,
}: FormSaveControllerOptions): FormSaveController {
  const [pendingEdits, setPendingEdits] = useState<Record<string, unknown>>({})
  /**
   * Saved, but not yet confirmed by the server.
   *
   * Separate from `pendingEdits` because the two mean different things to the
   * operator: pending is "you still have to save this", in-flight is "this is
   * on its way". Only the first should put the Save button back, but BOTH must
   * keep the value on screen — a Reolink battery write is a wake, a set and a
   * read-back, and for those seconds the old value is not the truth.
   */
  const [inFlightEdits, setInFlightEdits] = useState<Record<string, unknown>>({})
  const [editingPaused, setEditingPaused] = useState(false)
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sections = schema?.sections ?? []

  const hasPendingEdits = Object.keys(pendingEdits).length > 0

  const values = useMemo(
    // Pending last: an edit made WHILE a save travels is newer than the save.
    () => ({ ...serverValues, ...inFlightEdits, ...pendingEdits }),
    [serverValues, inFlightEdits, pendingEdits],
  )

  // Pause polling while editing, resume 500ms after last edit — and for as
  // long as a save is still travelling: a poll landing mid-write overwrites
  // the field with the value the write is in the middle of replacing.
  useEffect(() => {
    if (hasPendingEdits || Object.keys(inFlightEdits).length > 0) {
      setEditingPaused(true)
      return
    }
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = setTimeout(() => setEditingPaused(false), 500)
  }, [hasPendingEdits, inFlightEdits])

  // The resume timer outlives the form otherwise: it fired setState after
  // unmount (a test caught it after jsdom was torn down).
  useEffect(
    () => () => {
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    },
    [],
  )

  const markEditing = useCallback(() => {
    setEditingPaused(true)
    if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    pauseTimerRef.current = setTimeout(() => setEditingPaused(false), 2000)
  }, [])

  const handleChange = useCallback(
    (next: Record<string, unknown>) => {
      markEditing()
      const immediatePatch: Record<string, unknown> = {}
      const nextEdits: Record<string, unknown> = {}

      // Compute current effective values for comparison
      const effective = { ...serverValues, ...pendingEdits }

      for (const [key, value] of Object.entries(next)) {
        if (effective[key] === value) continue

        if (isImmediateField(sections, key)) {
          immediatePatch[key] = value
        } else {
          nextEdits[key] = value
        }
      }

      if (Object.keys(immediatePatch).length > 0) {
        onImmediateSave(immediatePatch)
      }

      // Merge deferred edits: keep existing pending, add new, remove flushed immediate keys
      setPendingEdits((prev) => {
        const merged = { ...prev }
        for (const k of Object.keys(immediatePatch)) delete merged[k]
        for (const [k, v] of Object.entries(nextEdits)) merged[k] = v
        return merged
      })
    },
    [markEditing, serverValues, pendingEdits, sections, onImmediateSave],
  )

  const handleSave = useCallback(
    (keys: readonly string[]) => {
      const patch: Record<string, unknown> = {}
      const remaining: Record<string, unknown> = {}

      for (const [k, v] of Object.entries(pendingEdits)) {
        if (keys.includes(k)) {
          patch[k] = v
        } else {
          remaining[k] = v
        }
      }

      setPendingEdits(remaining)
      if (Object.keys(patch).length === 0) return

      const savedKeys = Object.keys(patch)
      const settled = onDeferredSave(patch)
      if (settled === undefined || typeof settled.then !== 'function') return

      setInFlightEdits((prev) => ({ ...prev, ...patch }))
      const release = () =>
        setInFlightEdits((prev) => {
          const next = { ...prev }
          for (const k of savedKeys) delete next[k]
          return next
        })
      settled.then(release, () => {
        release()
        // A failed save hands the operator their own text back, where they can
        // see it and retry. Dropping it silently is worse than the revert this
        // whole overlay exists to prevent. An edit made since we started wins.
        setPendingEdits((prev) => {
          const next = { ...prev }
          for (const k of savedKeys) {
            if (!(k in next)) next[k] = patch[k]
          }
          return next
        })
      })
    },
    [pendingEdits, onDeferredSave],
  )

  const handleDiscard = useCallback((keys: readonly string[]) => {
    setPendingEdits((prev) => {
      const next = { ...prev }
      for (const k of keys) delete next[k]
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    setPendingEdits({})
  }, [])

  return {
    values,
    pendingKeys: Object.keys(pendingEdits),
    hasPendingEdits,
    editingPaused,
    handleChange,
    handleSave,
    handleDiscard,
    resetAll,
  }
}
