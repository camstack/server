/**
 * AI → Profiles. The `llm` cap's rows, entirely cap-driven (no per-kind UI).
 *
 * Two changes from the shape this page shipped with, both of them the same
 * defect the Notification Center was fixed for on 2026-08-14:
 *
 *  - the rows were a `<ul>` of flex items, so nothing was a COLUMN: an
 *    operator comparing "which of these is vision-capable" or "which node runs
 *    this one" had to read each row as prose. It is a `DataTable` now, a real
 *    table at every width (the comparison is the
 *    point), scrolling its own body so the page's "Add profile" button stays
 *    put however many profiles exist.
 *  - the editor was an inline card appended below the list. It is a dialog.
 */
import type {
  ConfigUISchema,
  LlmDefault,
  LlmProfile,
  LlmProfileKindDescriptor,
} from '@camstack/types'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorBox,
  Label,
  SECTION_BODY,
  STACK_GAP,
  SectionCard,
  Select,
  Skeleton,
  Switch,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useItemFormUrl,
  useSystem,
} from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2, Pencil, Send, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULTS_KEY, DEFAULT_PURPOSES, KINDS_KEY, PROFILES_KEY } from './ai-page.helpers'
import { KindGlyph, KindPickerDialog, ProfileEditorDialog } from './AiProfileEditor'
import i18n from '../../i18n/index'

interface TestResult {
  readonly id: string
  readonly text: string
  readonly ok: boolean
}

interface ProfileColumnsDeps {
  readonly kindByName: ReadonlyMap<string, LlmProfileKindDescriptor>
  readonly testResult: TestResult | null
  readonly testingId: string | null
  readonly t: (key: string, fallback: string) => string
  readonly onToggle: (profile: LlmProfile) => void
  readonly onTest: (profile: LlmProfile) => void
  readonly onEdit: (profile: LlmProfile) => void
  readonly onDelete: (profile: LlmProfile) => void
}

function profileColumns(deps: ProfileColumnsDeps): readonly DataColumn<LlmProfile>[] {
  return [
    {
      key: 'name',
      header: deps.t('ai.colProfile', 'Profile'),
      render: (p) => {
        const kind = deps.kindByName.get(p.kind)
        return (
          <span className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface"
              title={kind?.label ?? p.kind}
            >
              {kind !== undefined ? (
                <KindGlyph kind={kind} className="h-4 w-4 text-foreground-subtle" />
              ) : (
                <span className="text-xs text-foreground-subtle">?</span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">{p.name}</span>
              {/* The test verdict rides UNDER the name it is about. A shared
                  banner elsewhere on the page cannot say which row it means. */}
              {deps.testResult?.id === p.id && (
                <span
                  className={`block truncate ${deps.testResult.ok ? 'text-success' : 'text-danger'}`}
                >
                  {deps.testResult.text}
                </span>
              )}
            </span>
          </span>
        )
      },
    },
    {
      key: 'kind',
      header: deps.t('ai.colKind', 'Kind'),
      nowrap: true,
      render: (p) => (
        <span className="text-foreground-muted">
          {deps.kindByName.get(p.kind)?.label ?? p.kind}
        </span>
      ),
    },
    {
      key: 'model',
      header: deps.t('ai.colModel', 'Model'),
      render: (p) => <span className="text-foreground">{p.model}</span>,
    },
    {
      key: 'vision',
      header: deps.t('ai.colVision', 'Vision'),
      align: 'center',
      nowrap: true,
      render: (p) =>
        p.supportsVision ? (
          <Badge variant="info" style="outline">
            {deps.t('ai.vision', 'vision')}
          </Badge>
        ) : (
          <span className="text-foreground-subtle">—</span>
        ),
    },
    {
      key: 'node',
      header: deps.t('ai.colNode', 'Node'),
      nowrap: true,
      // A kind that runs on a node keeps it as `providerConfig.nodeId`.
      render: (p) =>
        typeof p.providerConfig.nodeId === 'string' ? (
          <Badge variant="default">{p.providerConfig.nodeId}</Badge>
        ) : (
          <span className="text-foreground-subtle">—</span>
        ),
    },
    {
      key: 'enabled',
      header: deps.t('ai.colOn', 'On'),
      align: 'center',
      nowrap: true,
      render: (p) => (
        <Switch
          checked={p.enabled}
          onCheckedChange={() => deps.onToggle(p)}
          aria-label={i18n.t('system.aiProfilesTab.toggle', 'toggle {{name}}', { name: p.name })}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      render: (p) => (
        <span className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => deps.onTest(p)}
            aria-label={deps.t('ai.test', 'Test')}
            title={deps.t('ai.test', 'Test')}
          >
            {deps.testingId === p.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={!deps.kindByName.has(p.kind)}
            onClick={() => deps.onEdit(p)}
            aria-label={deps.t('common.edit', 'Edit')}
            title={deps.t('common.edit', 'Edit')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => deps.onDelete(p)}
            aria-label={deps.t('common.delete', 'Delete')}
            title={deps.t('common.delete', 'Delete')}
          >
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
        </span>
      ),
    },
  ]
}

export function AiProfilesTabPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const { state: formUrl, openEdit, close: closeForm } = useItemFormUrl()
  const confirm = useConfirm()
  /** Kind chosen after `?new=1` opens the picker; cleared when the URL closes. */
  const [pickedKind, setPickedKind] = useState<LlmProfileKindDescriptor | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const profilesQuery = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: (): Promise<readonly LlmProfile[]> => system.trpcClient.llm.listProfiles.query({}),
  })
  const kindsQuery = useQuery({
    queryKey: KINDS_KEY,
    queryFn: async (): Promise<readonly LlmProfileKindDescriptor[]> => {
      const raw = await system.trpcClient.llm.listProfileKinds.query({})
      // `connectionSchema` / `advancedSchema` are `z.unknown()` at the cap seam
      // but ConfigUISchema by contract (llm.cap.ts). Documented type boundary.
      return raw.map(
        ({ connectionSchema, advancedSchema, ...k }): LlmProfileKindDescriptor => ({
          ...k,
          connectionSchema: connectionSchema as ConfigUISchema,
          ...(advancedSchema !== undefined
            ? { advancedSchema: advancedSchema as ConfigUISchema }
            : {}),
        }),
      )
    },
  })

  const refresh = (): void => {
    void profilesQuery.refetch()
  }

  const closeEditor = useCallback((): void => {
    setPickedKind(null)
    setSaveError(null)
    closeForm()
  }, [closeForm])

  useEffect(() => {
    if (formUrl.mode === 'closed') setPickedKind(null)
  }, [formUrl.mode])

  const upsert = useMutation({
    mutationFn: (profile: LlmProfile) => system.trpcClient.llm.upsertProfile.mutate({ profile }),
    onSuccess: () => {
      closeEditor()
      refresh()
    },
    onError: (err: unknown) =>
      setSaveError(err instanceof Error ? err.message : t('ai.saveFailed', 'Save failed')),
  })
  const remove = useMutation({
    mutationFn: (profile: LlmProfile) =>
      system.trpcClient.llm.deleteProfile.mutate({
        addonId: profile.addonId,
        profileId: profile.id,
      }),
    onSuccess: refresh,
  })
  const test = useMutation({
    mutationFn: (profile: LlmProfile) =>
      system.trpcClient.llm.testProfile.mutate({
        addonId: profile.addonId,
        profileId: profile.id,
      }),
    onSuccess: (result, profile) =>
      setTestResult({
        id: profile.id,
        ok: result.ok,
        text: result.ok
          ? i18n.t('system.aiProfilesTab.testOk', {
              text: result.text,
              tokens: result.usage.outputTokens,
              ms: result.latencyMs,
            })
          : `${result.code}: ${result.message}`,
      }),
  })

  const profiles = profilesQuery.data ?? []
  const kinds = useMemo(() => kindsQuery.data ?? [], [kindsQuery.data])
  const kindByName = useMemo(() => {
    const m = new Map<string, LlmProfileKindDescriptor>()
    for (const k of kinds) m.set(k.kind, k)
    return m
  }, [kinds])

  const editingProfile =
    formUrl.mode === 'edit' ? (profiles.find((p) => p.id === formUrl.id) ?? null) : null
  const editingKind = editingProfile !== null ? (kindByName.get(editingProfile.kind) ?? null) : null
  const showKindPicker = formUrl.mode === 'new' && pickedKind === null
  const formKind = formUrl.mode === 'new' ? pickedKind : editingKind
  const formProfile = formUrl.mode === 'edit' ? editingProfile : null
  const showForm = formKind !== null && (formUrl.mode === 'new' || formProfile !== null)

  const askDelete = async (p: LlmProfile): Promise<void> => {
    const ok = await confirm({
      title: t('ai.deleteProfileTitle', 'Delete profile?'),
      message: t(
        'ai.deleteProfileMessage',
        'Delete "{{name}}". Features that name it will no longer get an answer from it.',
        { name: p.name },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (ok) remove.mutate(p)
  }

  // "Add profile" lives in the page header (AiProfiles.tsx) and opens this
  // section's editor through the same `?new=1` this component reads.
  return (
    <div className={STACK_GAP}>
      <DefaultsCard profiles={profiles} />

      <SectionCard headingId="ai-profiles-list" title={t('ai.profilesList', 'Profiles')}>
        {profilesQuery.isPending ? (
          <div className={`${SECTION_BODY} space-y-2`} data-testid="ai-profiles-loading">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : profilesQuery.isError ? (
          <div className={SECTION_BODY}>
            <ErrorBox
              title={t('ai.loadFailed', 'Failed to load profiles')}
              message={
                profilesQuery.error instanceof Error
                  ? profilesQuery.error.message
                  : t('common.error', 'Error')
              }
              onRetry={() => void profilesQuery.refetch()}
            />
          </div>
        ) : profiles.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t('ai.noProfilesTitle', 'No AI profiles yet')}
            description={t(
              'ai.noProfiles',
              'No AI profiles yet. Click "Add profile" to configure one.',
            )}
          />
        ) : (
          <DataTable<LlmProfile>
            columns={profileColumns({
              kindByName,
              testResult,
              testingId: test.isPending ? (test.variables?.id ?? null) : null,
              t,
              onToggle: (p) =>
                // The toggle re-sends the profile it read: its `providerConfig`
                // carries the redacted marker for a stored key, which the
                // provider keeps — the switch never erases a key.
                upsert.mutate({ ...p, enabled: !p.enabled }),
              onTest: (p) => test.mutate(p),
              onEdit: (p) => {
                if (!kindByName.has(p.kind)) return
                setSaveError(null)
                setPickedKind(null)
                openEdit(p.id)
              },
              onDelete: (p) => void askDelete(p),
            })}
            rows={profiles}
            rowKey={(p) => p.id}
            minWidthPx={760}
            bordered={false}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
          />
        )}
      </SectionCard>

      {showKindPicker && (
        <KindPickerDialog
          kinds={kinds}
          onCancel={closeEditor}
          onPick={(kind) => {
            setSaveError(null)
            setPickedKind(kind)
          }}
        />
      )}
      {showForm && formKind !== null && (
        <ProfileEditorDialog
          kind={formKind}
          existing={formProfile}
          saving={upsert.isPending}
          error={saveError}
          onSave={(profile) => upsert.mutate(profile)}
          onCancel={closeEditor}
          {...(formUrl.mode === 'new'
            ? {
                onChangeKind: () => {
                  setSaveError(null)
                  setPickedKind(null)
                },
              }
            : {})}
        />
      )}
    </div>
  )
}

interface DefaultsCardProps {
  readonly profiles: readonly LlmProfile[]
}

/**
 * WHICH profile answers when a caller names none.
 *
 * `getDefaults`/`setDefault` shipped with the cap and had no surface: the
 * confirm gate, the scene monitors and every future consumer resolve through
 * this chain, and the only way to set it was a hand-written tRPC call.
 *
 * A default naming a DISABLED profile resolves to nothing at call time, so the
 * warning lives HERE — where the choice is made — rather than surfacing as a
 * `no-profile` error inside whatever feature happened to ask first.
 */
function DefaultsCard({ profiles }: DefaultsCardProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const defaultsQuery = useQuery({
    queryKey: DEFAULTS_KEY,
    queryFn: (): Promise<readonly LlmDefault[]> => system.trpcClient.llm.getDefaults.query({}),
  })
  const setDefault = useMutation({
    mutationFn: (input: { purpose: 'text' | 'vision'; profileId: string | null }) =>
      system.trpcClient.llm.setDefault.mutate({
        selector: { purpose: input.purpose },
        profileId: input.profileId,
      }),
    onSuccess: () => {
      void defaultsQuery.refetch()
    },
  })

  const currentFor = (purpose: 'text' | 'vision'): string => {
    const match = (defaultsQuery.data ?? []).find(
      (d) => 'purpose' in d.selector && d.selector.purpose === purpose,
    )
    return match?.profileId ?? ''
  }

  const labelFor = (purpose: 'text' | 'vision'): string =>
    purpose === 'vision'
      ? t('ai.defaultVision', 'Default vision profile')
      : t('ai.defaultText', 'Default text profile')

  return (
    <SectionCard headingId="ai-profiles-defaults" title={t('ai.defaultsTitle', 'Defaults')}>
      <div className={`${SECTION_BODY} grid gap-4 sm:grid-cols-2`}>
        {DEFAULT_PURPOSES.map(({ purpose, visionOnly }) => {
          const eligible = visionOnly ? profiles.filter((p) => p.supportsVision) : profiles
          const current = currentFor(purpose)
          const chosen = profiles.find((p) => p.id === current)
          return (
            <div key={purpose}>
              <Label className="mb-1 block" htmlFor={`llm-default-${purpose}`}>
                {labelFor(purpose)}
              </Label>
              <Select
                id={`llm-default-${purpose}`}
                aria-label={labelFor(purpose)}
                value={current}
                onChange={(e) =>
                  setDefault.mutate({
                    purpose,
                    // An empty option value is the DOM's only "nothing"; the cap
                    // spells it `null`, and '' would be stored as a profile id
                    // that resolves to no profile forever.
                    profileId: e.target.value === '' ? null : e.target.value,
                  })
                }
                options={[
                  { value: '', label: t('ai.none', 'None') },
                  // The stored id ALWAYS has an option, even when the profile
                  // list has not arrived or no longer contains it. Without one
                  // a `<select>` silently falls back to "None" and the next
                  // keystroke writes that fallback back — the picker would
                  // erase the very default it was opened to show.
                  ...(current !== '' && !eligible.some((p) => p.id === current)
                    ? [{ value: current, label: chosen?.name ?? current }]
                    : []),
                  ...eligible.map((p) => ({
                    value: p.id,
                    label: `${p.name} · ${p.model}`,
                  })),
                ]}
              />
              {current !== '' && chosen === undefined && (
                <p className="mt-1 text-xs text-danger">
                  {t('ai.defaultMissing', 'This default names a profile that no longer exists.')}
                </p>
              )}
              {chosen !== undefined && !chosen.enabled && (
                <p className="mt-1 text-xs text-warning">
                  {t(
                    'ai.defaultDisabled',
                    'This default profile is disabled — callers resolve to no profile.',
                  )}
                </p>
              )}
              {setDefault.error != null && (
                <p className="mt-1 text-xs text-danger">{String(setDefault.error)}</p>
              )}
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}
