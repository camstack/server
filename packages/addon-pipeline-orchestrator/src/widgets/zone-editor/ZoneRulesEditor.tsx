/**
 * ZoneRulesEditor — primitive form for an array of {@link ZoneRule}.
 *
 * Bound to the DeviceProxy reactive state for live updates:
 *   - `useDeviceStateSlice(dev?.state.zoneRules)` reads the unified
 *     `{motion, detection}` runtime-state slice and re-renders on
 *     every push from the orchestrator's mirror write.
 *   - `dev?.zoneRules?.setRules(...)` for the bulk-replace mutation
 *     (the proxy auto-injects deviceId + nodeId).
 *
 * Renders one row per rule with a name input, zone multi-select
 * sourced from the live zones[] passed in, mode toggle, comma-
 * separated classFilter, enabled toggle, and an inline Remove
 * button. "Add rule" appends a fresh empty row; "Save" dispatches
 * the full array.
 */
import { Plus, Trash2, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Zone, ZoneRule, ZoneRuleStage, DeviceProxy } from '@camstack/types'
import { MACRO_LABELS } from '@camstack/types'
import { useT } from '../../i18n/index.js'
import { zoneRuleStageTitle } from './zone-rule-stage.js'
import { stageHasClassFilter } from './zone-rule-class-filter.js'
import {
  useDeviceStateSlice,
  BTN_COMPACT,
  BTN_COMPACT_PRIMARY,
  CHIP_BASE,
  CHIP_ACTIVE,
  CHIP_INACTIVE,
  INPUT_COMPACT,
  TEXT_SECTION_LABEL,
} from '@camstack/ui-library'

// Pre-built macro class chips. The pipeline today only routes the three
// macro classes (person / vehicle / animal); rules referencing raw COCO
// classes (e.g. 'car') are dropped upstream — see `COCO_TO_MACRO`
// `preserveOriginal: false` in `packages/types/src/catalogs/coco-classmap.ts`.
const MACRO_CHIPS: readonly { id: string; label: string }[] = MACRO_LABELS.map((m) => ({
  id: m.id,
  label: m.name,
}))

export interface ZoneRulesEditorProps {
  readonly dev: DeviceProxy | null
  readonly stage: ZoneRuleStage
  readonly zones: readonly Zone[]
  readonly title?: string
}

interface DraftRule {
  readonly id: string
  readonly name: string
  readonly zoneIds: readonly string[]
  readonly mode: 'include' | 'exclude'
  readonly classFilter: readonly string[]
  readonly enabled: boolean
  readonly detectBySceneDifference: boolean
  readonly confirmWithLlm: boolean
}

function ruleFromCap(r: ZoneRule): DraftRule {
  return {
    id: r.id,
    name: r.name ?? '',
    zoneIds: r.zoneIds,
    mode: r.mode,
    classFilter: r.classFilter ?? [],
    enabled: r.enabled !== false,
    detectBySceneDifference: r.detectBySceneDifference === true,
    confirmWithLlm: r.confirmWithLlm === true,
  }
}

function ruleToCap(d: DraftRule, stage: ZoneRuleStage): ZoneRule {
  return {
    id: d.id,
    zoneIds: d.zoneIds,
    mode: d.mode,
    enabled: d.enabled,
    ...(d.name !== '' ? { name: d.name } : {}),
    ...(d.classFilter.length > 0 ? { classFilter: d.classFilter } : {}),
    ...(stage === 'package'
      ? {
          detectBySceneDifference: d.detectBySceneDifference,
          confirmWithLlm: d.confirmWithLlm,
        }
      : {}),
  }
}

interface PackageOptionProps {
  readonly on: boolean
  readonly label: string
  readonly hint: string
  readonly onToggle: () => void
}

function PackageOption({ on, label, hint, onToggle }: PackageOptionProps) {
  return (
    <div className="flex items-center gap-1.5">
      <button // ui-check-ok: same switch chrome as the rule enable toggle in this editor
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={hint}
        onClick={onToggle}
        className={[
          'inline-flex items-center justify-center h-5 w-9 rounded-full border transition-colors flex-shrink-0',
          on
            ? 'border-primary/50 bg-primary/20 text-primary'
            : 'border-border bg-surface text-foreground-subtle',
        ].join(' ')}
      >
        <span
          className={[
            'h-3 w-3 rounded-full transition-transform',
            on ? 'translate-x-1.5 bg-primary' : '-translate-x-1.5 bg-foreground-subtle',
          ].join(' ')}
        />
      </button>
      <span className="text-[10px] text-foreground leading-tight">{label}</span>
    </div>
  )
}

export function ZoneRulesEditor({ dev, stage, zones, title }: ZoneRulesEditorProps) {
  const { t } = useT()
  // Reactive read — re-renders on every mirror push for the unified
  // `zone-rules` slice. The slice carries both stages; we pick the
  // one this editor owns.
  const rulesSlice = useDeviceStateSlice(dev?.state.zoneRules)
  const persisted = useMemo<readonly ZoneRule[]>(
    () => rulesSlice?.[stage] ?? [],
    [rulesSlice, stage],
  )

  const [drafts, setDrafts] = useState<DraftRule[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Object-class chips only make sense where the gate reads `classFilter`
  // (detection stage). Motion regions have no class and package objects are
  // always the `package` class, so the selector is hidden there — it would
  // be a control that changes nothing. See `zone-rule-class-filter.ts`.
  const showClassFilter = stageHasClassFilter(stage)

  // Hydrate drafts from the live slice whenever it changes (and we
  // haven't pending edits the user hasn't saved yet).
  useEffect(() => {
    if (!dirty) setDrafts(persisted.map(ruleFromCap))
  }, [persisted, dirty])

  const onAdd = () => {
    setDrafts((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: '',
        zoneIds: zones[0] ? [zones[0].id] : [],
        mode: 'exclude',
        classFilter: [],
        enabled: true,
        detectBySceneDifference: false,
        confirmWithLlm: false,
      },
    ])
    setDirty(true)
  }

  const toggleClass = (idx: number, classId: string) => {
    setDrafts((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r
        const has = r.classFilter.includes(classId)
        const next = has ? r.classFilter.filter((c) => c !== classId) : [...r.classFilter, classId]
        return { ...r, classFilter: next }
      }),
    )
    setDirty(true)
  }

  const toggleZone = (idx: number, zoneId: string) => {
    setDrafts((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r
        const has = r.zoneIds.includes(zoneId)
        const next = has ? r.zoneIds.filter((z) => z !== zoneId) : [...r.zoneIds, zoneId]
        return { ...r, zoneIds: next }
      }),
    )
    setDirty(true)
  }

  const onRemove = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx))
    setDirty(true)
  }

  const onChange = (idx: number, patch: Partial<DraftRule>) => {
    setDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  const onSave = async () => {
    if (!dev?.zoneRules) return
    setSaving(true)
    setError(null)
    try {
      await dev.zoneRules.setRules({ stage, rules: drafts.map((d) => ruleToCap(d, stage)) })
      setDirty(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const canSave = dirty && Boolean(dev?.zoneRules) && !saving

  return (
    <div className="rounded-md border border-border bg-surface/40 p-2.5">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className={`${TEXT_SECTION_LABEL} truncate`}>{title ?? zoneRuleStageTitle(stage)}</h3>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onAdd}
            disabled={zones.length === 0 || !dev}
            className={BTN_COMPACT}
            title={t('rules.add')}
          >
            <Plus className="h-2.5 w-2.5" /> {t('rules.addShort')}
          </button>
          <button
            type="button"
            onClick={() => {
              void onSave()
            }}
            disabled={!canSave}
            className={BTN_COMPACT_PRIMARY}
          >
            <Save className="h-2.5 w-2.5" />
            {saving ? '…' : t('rules.save')}
          </button>
        </div>
      </div>

      {drafts.length === 0 ? (
        <p className="text-[10px] text-foreground-subtle italic px-1 py-1.5 leading-tight">
          {zones.length === 0 ? t('rules.noZones') : t('rules.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {drafts.map((d, idx) => (
            <div
              key={d.id}
              className="rounded border border-border/50 bg-background/40 px-2 py-1.5 flex flex-col gap-1.5 overflow-hidden"
            >
              {/* Header — fixed grid (switch | name | trash) so the
                  toggle and the delete button never get pushed off
                  the card on narrow widths. The name input takes the
                  remaining space and shrinks instead of overflowing. */}
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={d.enabled}
                  aria-label={d.enabled ? t('rules.disable') : t('rules.enable')}
                  title={d.enabled ? t('rules.activeTitle') : t('rules.disabledTitle')}
                  onClick={() => onChange(idx, { enabled: !d.enabled })}
                  className={[
                    'inline-flex items-center justify-center h-5 w-9 rounded-full border transition-colors flex-shrink-0',
                    d.enabled
                      ? 'border-primary/50 bg-primary/20 text-primary'
                      : 'border-border bg-surface text-foreground-subtle',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'h-3 w-3 rounded-full transition-transform',
                      d.enabled
                        ? 'translate-x-1.5 bg-primary'
                        : '-translate-x-1.5 bg-foreground-subtle',
                    ].join(' ')}
                  />
                </button>
                <input
                  className={`${INPUT_COMPACT} min-w-0`}
                  placeholder={t('rules.namePlaceholder')}
                  value={d.name}
                  onChange={(e) => onChange(idx, { name: e.target.value })}
                />
                <button
                  type="button"
                  title={t('rules.remove')}
                  aria-label={t('rules.remove')}
                  onClick={() => onRemove(idx)}
                  className="flex items-center justify-center h-6 w-6 rounded text-foreground-subtle hover:text-danger hover:bg-danger/10 transition-colors flex-shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Mode — pill toggle. Visually consistent with the
                  zone / class chip rows below; replaces the previous
                  bare select that read as a "random input" next to
                  the unlabelled name field. */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] uppercase tracking-wider text-foreground-subtle w-12 sm:w-14 flex-shrink-0">
                  {t('rules.mode')}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(idx, { mode: 'include' })}
                  className={`${CHIP_BASE} ${d.mode === 'include' ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                >
                  {t('rules.include')}
                </button>
                <button
                  type="button"
                  onClick={() => onChange(idx, { mode: 'exclude' })}
                  className={`${CHIP_BASE} ${d.mode === 'exclude' ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                >
                  {t('rules.exclude')}
                </button>
              </div>

              {/* Zone chips. Empty zoneIds means "every zone". */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] uppercase tracking-wider text-foreground-subtle w-12 sm:w-14 flex-shrink-0">
                  {t('rules.zones')}
                </span>
                {zones.length === 0 ? (
                  <span className="text-[10px] text-foreground-subtle italic">
                    {t('rules.noneZones')}
                  </span>
                ) : (
                  zones.map((z) => {
                    const active = d.zoneIds.includes(z.id)
                    return (
                      <button
                        key={z.id}
                        type="button"
                        onClick={() => toggleZone(idx, z.id)}
                        className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                      >
                        <span
                          className="h-2 w-2 rounded-sm"
                          style={{ backgroundColor: z.color || '#3b82f6' }}
                        />
                        <span className="truncate max-w-[7rem]">{z.name || z.id}</span>
                      </button>
                    )
                  })
                )}
              </div>

              {/* Class chips (3 macro classes only — see
                  COCO_TO_MACRO `preserveOriginal: false`). Empty
                  classFilter means "every class". Rendered only for stages
                  whose gate actually reads classFilter (detection). */}
              {stage === 'package' && (
                <div className="flex flex-col gap-1">
                  <PackageOption
                    on={d.detectBySceneDifference}
                    label={t('rules.sceneDifference')}
                    hint={t('rules.sceneDifferenceHint')}
                    onToggle={() =>
                      onChange(idx, { detectBySceneDifference: !d.detectBySceneDifference })
                    }
                  />
                  <PackageOption
                    on={d.confirmWithLlm}
                    label={t('rules.confirmLlm')}
                    hint={t('rules.confirmLlmHint')}
                    onToggle={() => onChange(idx, { confirmWithLlm: !d.confirmWithLlm })}
                  />
                </div>
              )}

              {showClassFilter && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9px] uppercase tracking-wider text-foreground-subtle w-12 sm:w-14 flex-shrink-0">
                    {t('rules.class')}
                  </span>
                  {MACRO_CHIPS.map((c) => {
                    const active = d.classFilter.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleClass(idx, c.id)}
                        className={`${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_INACTIVE}`}
                      >
                        {c.label}
                      </button>
                    )
                  })}
                  {d.classFilter.length === 0 && (
                    <span className="text-[10px] text-foreground-subtle italic ml-1">
                      {t('rules.anyClass')}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
    </div>
  )
}
