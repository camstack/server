/**
 * PipelineBuilder — orchestrates the pipeline step tree.
 *
 * Renders the step tree from schema with nested children and placeholder steps
 * for disabled addons, all driven by API schema. There are no saved pipeline
 * templates (D759): the tree is the caller's state.
 */
import { useMemo, type JSX } from 'react'
import { PlusCircle } from 'lucide-react'
import { useUiText } from '../contexts/ui-text'
import type { PipelineSchema, PipelineAddonSchema } from '@camstack/types'
import { PipelineStep } from './pipeline-step'
import type { PipelineStepDisplayConfig } from './pipeline-step'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface PipelineBuilderProps {
  readonly schema: PipelineSchema
  readonly steps: readonly PipelineStepDisplayConfig[]
  readonly onChange: (steps: readonly PipelineStepDisplayConfig[]) => void
  readonly readOnly?: boolean
  /** Addon IDs to exclude from the pipeline (e.g. 'motion-detection' for benchmark) */
  readonly excludeAddons?: readonly string[]
  /** Only show enabled steps (hide disabled addons and placeholders) */
  readonly showOnlyEnabled?: boolean
  /** Show "Slot: ..." labels above step groups (default: false) */
  readonly showSlotLabels?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSchemaMap(schema: PipelineSchema): Map<string, PipelineAddonSchema> {
  const map = new Map<string, PipelineAddonSchema>()
  for (const slot of schema.slots) {
    for (const addon of slot.addons) {
      map.set(addon.id, addon)
    }
  }
  return map
}

function createDefaultStep(addon: PipelineAddonSchema): PipelineStepDisplayConfig {
  return {
    addonId: addon.id,
    addonName: addon.name,
    slot: addon.slot,
    inputClasses: [...addon.inputClasses],
    outputClasses: [...addon.outputClasses],
    enabled: true,
    modelId: addon.defaultModelId,
    children: [],
    // Phase 7: no generic `confidence` field. Per-step thresholds live
    // in `settings` and are initialised by the dynamic `ConfigSchemaField`
    // defaults when the form builder mounts the step's `configSchema`.
  }
}

// ---------------------------------------------------------------------------
// Placeholder step — dashed card with plus icon, class I/O tags
// ---------------------------------------------------------------------------

function PlaceholderStep({ addon, onClick }: { addon: PipelineAddonSchema; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-left transition-all hover:border-primary/30 hover:bg-surface/60 group"
    >
      <div className="flex items-center gap-3">
        <PlusCircle className="h-[18px] w-[18px] text-foreground-subtle/30 group-hover:text-primary/60 shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-[13px] font-medium text-foreground-subtle/50 group-hover:text-foreground-subtle block truncate">
            {addon.name}
          </span>
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            {addon.inputClasses.map((c) => (
              <span
                key={c}
                className="text-[9px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-blue-500/8 text-blue-400/50"
              >
                {c}
              </span>
            ))}
            {addon.inputClasses.length > 0 && addon.outputClasses.length > 0 && (
              <span className="text-foreground-subtle/25 text-[10px]">→</span>
            )}
            {addon.outputClasses.map((c) => (
              <span
                key={c}
                className="text-[9px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-green-500/8 text-green-400/50"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PipelineBuilder({
  schema,
  steps,
  onChange,
  readOnly = false,
  excludeAddons = [],
  showOnlyEnabled = false,
  showSlotLabels = false,
}: PipelineBuilderProps): JSX.Element {
  const t = useUiText()
  const excluded = useMemo(() => new Set(excludeAddons), [excludeAddons])
  const schemaMap = useMemo(() => buildSchemaMap(schema), [schema])
  // ── Step handlers ──────────────────────────────────────────────

  /**
   * When a step is updated, auto-enable the entire ancestor chain if a
   * child/grandchild was just enabled. This ensures enabling face-recognition
   * automatically enables face-detection and object-detection.
   */
  function handleStepChange(updated: PipelineStepDisplayConfig) {
    onChange(
      steps.map((s) => {
        if (s.addonId !== updated.addonId) return s
        return autoEnableAncestors(updated)
      }),
    )
  }

  /** If any child or grandchild is enabled, ensure the parent is too */
  function autoEnableAncestors(step: PipelineStepDisplayConfig): PipelineStepDisplayConfig {
    const hasEnabledChild = step.children.some(
      (c) => c.enabled || c.children.some((gc) => gc.enabled),
    )
    return {
      ...step,
      enabled: step.enabled || hasEnabledChild,
      children: step.children.map((c) => {
        const hasEnabledGrandchild = c.children.some((gc) => gc.enabled)
        return {
          ...c,
          enabled: c.enabled || hasEnabledGrandchild,
        }
      }),
    }
  }

  function handleAddChildToStep(parentAddonId: string, addon: PipelineAddonSchema) {
    const child = createDefaultStep(addon)
    onChange(
      steps.map((s) => {
        if (s.addonId !== parentAddonId) return s
        return { ...s, children: [...s.children, child] }
      }),
    )
  }

  // ── Rendering ──────────────────────────────────────────────────

  // Collect all addon IDs already in the tree (including nested)
  function collectIds(list: readonly PipelineStepDisplayConfig[]): Set<string> {
    const ids = new Set<string>()
    for (const s of list) {
      ids.add(s.addonId)
      for (const c of s.children) ids.add(c.addonId)
      // Recurse deeper
      const childIds = collectIds(s.children)
      for (const id of childIds) ids.add(id)
    }
    return ids
  }

  const existingIds = collectIds(steps)

  // Get child-slot addons that could be children of a given step
  function getChildPlaceholders(step: PipelineStepDisplayConfig): PipelineAddonSchema[] {
    const stepSchema = schemaMap.get(step.addonId)
    if (!stepSchema) return []
    const parentSlotInfo = schema.slots.find((s) => s.id === stepSchema.slot)
    const parentIsRoot = parentSlotInfo?.parentSlot == null
    const childSlotIds = stepSchema.childSlots
    const childIds = new Set(step.children.map((c) => c.addonId))
    const placeholders: PipelineAddonSchema[] = []
    for (const slot of schema.slots) {
      if (!childSlotIds.includes(slot.id)) continue
      for (const addon of slot.addons) {
        if (childIds.has(addon.id) || excluded.has(addon.id)) continue
        // A step with an empty `inputClasses` is a "wildcard" — its
        // definition used `inputClasses: null` and the schema encodes that
        // as an empty array. These steps (e.g. full-frame segmenters) are
        // only meaningful as direct children of a root-slot step (i.e. a
        // root detector like `object-detection`), so they must not appear
        // as placeholders under croppers or classifiers.
        const isWildcard = addon.inputClasses.length === 0
        if (isWildcard && !parentIsRoot) continue
        const compatible =
          isWildcard || addon.inputClasses.some((ic) => step.outputClasses.includes(ic))
        if (compatible) placeholders.push(addon)
      }
    }
    return placeholders
  }

  function renderStep(rawStep: PipelineStepDisplayConfig): JSX.Element {
    // When showOnlyEnabled, filter out disabled children recursively
    const step = showOnlyEnabled
      ? {
          ...rawStep,
          children: rawStep.children
            .filter((c) => c.enabled)
            .map((c) => ({ ...c, children: c.children.filter((gc) => gc.enabled) })),
        }
      : rawStep
    const childPlaceholders = showOnlyEnabled ? [] : getChildPlaceholders(step)

    return (
      <div key={step.addonId} className="space-y-1.5">
        <PipelineStep
          step={step}
          schema={schemaMap.get(step.addonId) ?? null}
          allSchemas={schemaMap}
          onChange={handleStepChange}
          onDelete={readOnly ? undefined : (id) => onChange(steps.filter((s) => s.addonId !== id))}
          readOnly={readOnly}
        />

        {/* Children + child placeholders — nested visually */}
        {(step.children.length > 0 || childPlaceholders.length > 0) && (
          <div className="ml-4 pl-3 border-l border-border/60 space-y-1.5">
            {/* Slot label for children */}
            {showSlotLabels && (
              <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/40">
                {t('uiLibrary.pipelineBuilder.slotCropper', 'Slot: Cropper / Classifier')}
              </span>
            )}

            {/* Existing child steps */}
            {step.children.map((child) => {
              const childChildPlaceholders = getChildPlaceholders(child)
              return (
                <div key={child.addonId} className="space-y-1.5">
                  <PipelineStep
                    step={child}
                    schema={schemaMap.get(child.addonId) ?? null}
                    allSchemas={schemaMap}
                    depth={1}
                    onChange={(updated) => {
                      handleStepChange({
                        ...step,
                        children: step.children.map((c) =>
                          c.addonId === updated.addonId ? updated : c,
                        ),
                      })
                    }}
                    onDelete={
                      readOnly
                        ? undefined
                        : (id) => {
                            handleStepChange({
                              ...step,
                              children: step.children.filter((c) => c.addonId !== id),
                            })
                          }
                    }
                    readOnly={readOnly}
                  />

                  {/* Sub-sub children (recognizers) + placeholders */}
                  {(child.children.length > 0 || childChildPlaceholders.length > 0) && (
                    <div className="ml-4 pl-3 border-l border-border/40 space-y-1.5">
                      {showSlotLabels && (
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/30">
                          {t('uiLibrary.pipelineBuilder.slotRecognizer', 'Slot: Recognizer')}
                        </span>
                      )}

                      {/* Existing recognizer steps */}
                      {child.children.map((grandchild) => (
                        <PipelineStep
                          key={grandchild.addonId}
                          step={grandchild}
                          schema={schemaMap.get(grandchild.addonId) ?? null}
                          allSchemas={schemaMap}
                          depth={2}
                          onChange={(updatedGrandchild) => {
                            handleStepChange({
                              ...step,
                              children: step.children.map((c) =>
                                c.addonId === child.addonId
                                  ? {
                                      ...c,
                                      children: c.children.map((gc) =>
                                        gc.addonId === updatedGrandchild.addonId
                                          ? updatedGrandchild
                                          : gc,
                                      ),
                                    }
                                  : c,
                              ),
                            })
                          }}
                          onDelete={
                            readOnly
                              ? undefined
                              : (id) => {
                                  handleStepChange({
                                    ...step,
                                    children: step.children.map((c) =>
                                      c.addonId === child.addonId
                                        ? {
                                            ...c,
                                            children: c.children.filter((gc) => gc.addonId !== id),
                                          }
                                        : c,
                                    ),
                                  })
                                }
                          }
                          readOnly={readOnly}
                        />
                      ))}

                      {/* Placeholder recognizers */}
                      {!readOnly &&
                        childChildPlaceholders.map((addon) => (
                          <PlaceholderStep
                            key={addon.id}
                            addon={addon}
                            onClick={() => {
                              const newChild = createDefaultStep(addon)
                              handleStepChange({
                                ...step,
                                children: step.children.map((c) =>
                                  c.addonId === child.addonId
                                    ? { ...c, children: [...c.children, newChild] }
                                    : c,
                                ),
                              })
                            }}
                          />
                        ))}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Placeholders for missing child addons */}
            {!readOnly &&
              childPlaceholders.map((addon) => (
                <PlaceholderStep
                  key={addon.id}
                  addon={addon}
                  onClick={() => handleAddChildToStep(step.addonId, addon)}
                />
              ))}
          </div>
        )}
      </div>
    )
  }

  // Root slots (detectors)
  const rootSlots = schema.slots
    .filter((s) => s.parentSlot === null)
    .toSorted((a, b) => a.priority - b.priority)

  return (
    <div className="space-y-4">
      {/* ── Step tree ───────────────────────────────────────────── */}
      {rootSlots.map((slot) => {
        const allSlotSteps = steps.filter((s) => s.slot === slot.id && !excluded.has(s.addonId))
        const slotSteps = showOnlyEnabled ? allSlotSteps.filter((s) => s.enabled) : allSlotSteps
        const missingRootAddons = showOnlyEnabled
          ? []
          : slot.addons.filter((a) => !existingIds.has(a.id) && !excluded.has(a.id))

        // Group steps: steps with the same `group` field are rendered under one heading
        const groups = new Map<string, (typeof slotSteps)[number][]>()
        const ungrouped: (typeof slotSteps)[number][] = []
        for (const step of slotSteps) {
          if (step.group) {
            if (!groups.has(step.group)) groups.set(step.group, [])
            groups.get(step.group)!.push(step)
          } else {
            ungrouped.push(step)
          }
        }

        return (
          <div key={slot.id} className="space-y-2">
            {showSlotLabels && (
              <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/50">
                {t('uiLibrary.pipelineBuilder.slotLabel', 'Slot: {{label}}', { label: slot.label })}
              </span>
            )}

            {/* Ungrouped steps */}
            {ungrouped.map((step) => renderStep(step))}

            {/* Grouped steps under shared heading */}
            {[...groups.entries()].map(([groupName, groupSteps]) => (
              <div key={groupName} className="space-y-2 rounded-lg border border-border/40 p-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-subtle/50 px-1">
                  {groupName}
                </span>
                {groupSteps.map((step) => renderStep(step))}
              </div>
            ))}

            {/* Root placeholders (e.g. add another detector) */}
            {!readOnly &&
              missingRootAddons.map((addon) => (
                <PlaceholderStep
                  key={addon.id}
                  addon={addon}
                  onClick={() => {
                    onChange([...steps, createDefaultStep(addon)])
                  }}
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}
