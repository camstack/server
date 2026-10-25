/**
 * AddonFormPane — single-addon FormBuilder wrapper owning a
 * `useFormSaveController` instance.
 *
 * Centralises the immediate-vs-deferred-save behaviour every consumer
 * used to re-implement inline (NodeAddonsSettingsPanel + any future
 * per-addon surface). Immediate fields auto-save and never sit in the
 * pending bucket; deferred edits accumulate in the controller's
 * overlay until the caller flushes them via the imperative handle.
 *
 * Orchestration pattern:
 *   - `onImmediateSave` — invoked as the controller observes a change
 *     on a field declared `immediate: true`. Parent routes to the
 *     right mutation (per-addon, per-device, ...).
 *   - `onStateChange`   — parent observes pending keys/values so it can
 *     aggregate a panel-level dirty counter across multiple panes and
 *     render a single save bar.
 *   - Imperative handle  — `flush()` returns the pending values + clears
 *     the pane's overlay; `discard()` drops them. Lets the parent's
 *     save button batch every pane's mutation in one click.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { FormBuilder } from './FormBuilder'
import { useFormSaveController } from '../../hooks/useFormSaveController'

export interface AddonFormPaneState {
  readonly addonId: string
  /** Pending deferred-edit keys (immediate saves never land here). */
  readonly pendingKeys: readonly string[]
  /** Pending deferred-edit values keyed by field key. */
  readonly pendingValues: Record<string, unknown>
}

export interface AddonFormPaneHandle {
  /** Return the pending patch + clear the pane's overlay. */
  readonly flush: () => Record<string, unknown>
  /** Drop the pane's overlay without firing any save. */
  readonly discard: () => void
}

interface AddonFormPaneProps {
  readonly addonId: string
  readonly schema: ConfigUISchemaWithValues
  readonly serverValues: Record<string, unknown>
  /** Fires for fields declared `immediate: true` — flushes on change. */
  readonly onImmediateSave: (addonId: string, patch: Record<string, unknown>) => void
  /**
   * Notified whenever the pane's pending state changes. Also fires on
   * mount with an empty state so the parent can initialise its dirty
   * aggregator predictably.
   */
  readonly onStateChange: (state: AddonFormPaneState) => void
  /**
   * Optional handler for inline schema-field actions (`actions: [...]`
   * on a field). Forwarded to the underlying FormBuilder. Parent owns
   * the action → cap mutation mapping (e.g. reprobe-engine).
   */
  readonly onAction?: (
    addonId: string,
    action: string,
    key: string,
    value?: unknown,
  ) => Promise<unknown>
  readonly disabled?: boolean
}

export const AddonFormPane = forwardRef<AddonFormPaneHandle, AddonFormPaneProps>(
  function AddonFormPane(
    { addonId, schema, serverValues, onImmediateSave, onStateChange, onAction, disabled },
    ref,
  ) {
    const controller = useFormSaveController({
      schema,
      serverValues,
      onImmediateSave: useCallback(
        (patch) => onImmediateSave(addonId, patch),
        [addonId, onImmediateSave],
      ),
      // Deferred save is orchestrated by the parent's imperative flush;
      // the controller doesn't need a callback here.
      onDeferredSave: useCallback(() => {
        /* parent-driven flush */
      }, []),
    })

    // Expose flush/discard to the parent so it can batch saves across
    // every pane with one button.
    useImperativeHandle(
      ref,
      () => ({
        flush: () => {
          const patch: Record<string, unknown> = {}
          for (const k of controller.pendingKeys) patch[k] = controller.values[k]
          // Clear pending without firing onDeferredSave (parent owns the
          // actual mutation). `handleDiscard` drops from the overlay only.
          controller.handleDiscard(controller.pendingKeys)
          return patch
        },
        discard: () => controller.resetAll(),
      }),
      [controller],
    )

    // Notify parent on pending change via stable signature. Ref avoids
    // stale-closure on the callback identity.
    const pendingKeys = controller.pendingKeys
    const pendingKeysSignature = pendingKeys.join('|')
    const pendingValuesSignature = useMemo(() => {
      return pendingKeys.map((k) => `${k}=${JSON.stringify(controller.values[k])}`).join(',')
    }, [pendingKeys, controller.values])
    const stateChangeRef = useRef(onStateChange)
    useEffect(() => {
      stateChangeRef.current = onStateChange
    }, [onStateChange])
    useEffect(() => {
      const pendingValues: Record<string, unknown> = {}
      for (const k of pendingKeys) pendingValues[k] = controller.values[k]
      stateChangeRef.current({ addonId, pendingKeys, pendingValues })
    }, [addonId, pendingKeysSignature, pendingValuesSignature])

    const handleAction = useMemo(() => {
      if (!onAction) return undefined
      return (action: string, key: string, value?: unknown) => onAction(addonId, action, key, value)
    }, [addonId, onAction])

    return (
      <FormBuilder
        schema={schema}
        values={controller.values}
        onChange={controller.handleChange}
        disabled={disabled}
        onAction={handleAction}
      />
    )
  },
)
