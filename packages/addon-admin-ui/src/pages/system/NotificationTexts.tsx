/**
 * Texts — every word the Notification Center can print, and the operator's
 * replacements (i18n Phase 2's edit surface).
 *
 * Phase 1 centralised the sentences into two shipped locale files behind a
 * four-layer chain (rule template → hub override → shipped locale → shipped
 * English). The override layer shipped EMPTY and had nothing that could write
 * it. This is that thing.
 *
 * Three states, kept distinct on purpose — the same discipline as the History
 * tab:
 *   - ROWS         → the catalog, one row per key.
 *   - UNAVAILABLE  → the `nc.getTexts` bridge action ERRORED. On a hub whose
 *                    `addon-post-analysis` predates Phase 2 that is the normal
 *                    answer, not a fault, and it must not look like "this hub
 *                    has no texts".
 *   - UNREADABLE   → it answered something this bundle cannot narrow. Also not
 *                    an empty table: an empty table invites a save.
 *
 * WHAT THE PAGE REFUSES TO PRETEND:
 *   - a rule that wrote its own title/body still wins over everything here
 *     (layer 1 is per-rule and unreachable from a per-key table), so the page
 *     says so instead of promising an authority it does not have;
 *   - editing a language the hub does not speak is allowed — that is how you
 *     prepare a switch — but the page says the words are not in use;
 *   - a plural key warns before it is flattened, because one text box cannot
 *     express "person / people" and the operator only finds out otherwise when
 *     a notification reads "1 people".
 */

import { Badge, Button, Card, ErrorBox, Input, Select, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Languages, Loader2, RotateCcw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { TemplateField } from '../../components/notifications/TemplateField'
import {
  buildOverridePatch,
  countPendingEdits,
  draftValue,
  filterTextEntries,
  isTextLanguage,
  NC_ADDON_ID,
  NC_GET_TEXTS_ACTION,
  NC_SET_LANGUAGE_ACTION,
  NC_SET_TEXT_OVERRIDES_ACTION,
  parseTextCatalog,
  pluralWarning,
  TEXT_LANGUAGE_LABELS,
  type TextCatalog,
  type TextEntry,
  type TextLanguage,
  textsKeyVars,
} from './notification-texts.helpers'
import { useTranslation } from 'react-i18next'

const TEXTS_QUERY_KEY = 'notificationTexts'

const SUBTITLE = 'Every sentence the Notification Center can print — and your wording for it.'

interface KeyRowProps {
  readonly entry: TextEntry
  readonly value: string
  readonly busy: boolean
  readonly onChange: (value: string) => void
  readonly onReset: () => void
}

/**
 * One key. The shipped text is always visible, even when overridden — it is the
 * only thing "reset" can go back to, and an operator comparing his wording to
 * the original should not have to save to see it.
 */
function KeyRow({ entry, value, busy, onChange, onReset }: KeyRowProps) {
  const { t } = useTranslation()
  const plural = pluralWarning(entry)
  const overridden = entry.override !== null
  return (
    <div
      className="flex flex-col gap-1.5 rounded border border-border p-3"
      data-testid={`text-row-${entry.key}`}
      data-source={entry.source}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <code className="text-xs font-medium">{entry.key}</code>
        {overridden ? <Badge variant="info">{t('common.customised')}</Badge> : null}
        {entry.source === 'fallback' ? (
          // The shipped locale does not carry this key; the sentence below is
          // the English one. Silence here reads as a translation that exists.
          <Badge variant="warning">
            {t('system.notificationTexts.englishFallback', 'English fallback')}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <TemplateField
            label=""
            value={value}
            onChange={onChange}
            vars={textsKeyVars(entry)}
            disabled={busy}
            testId={`text-input-${entry.key}`}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || (!overridden && value === entry.shipped)}
          onClick={onReset}
          title={t(
            'system.notificationTexts.resetToTheShippedWording',
            'Reset to the shipped wording',
          )}
          data-testid={`text-reset-${entry.key}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <p className="text-xs text-foreground-subtle">
        <span className="font-medium">{t('system.notificationTexts.shipped', 'Shipped:')}</span>{' '}
        <span className="font-mono">{entry.shipped}</span>
      </p>
      {plural !== null ? <p className="text-xs text-warning">{plural}</p> : null}
    </div>
  )
}

export function NotificationTextsPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()

  /** Which locale's texts are on screen. Null until the first answer tells us
   *  the hub's own — the page never guesses a language before it knows one. */
  const [viewing, setViewing] = useState<TextLanguage | null>(null)
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())
  const [unreadable, setUnreadable] = useState(false)

  const catalogQuery = useQuery({
    queryKey: [TEXTS_QUERY_KEY, viewing ?? 'hub'],
    queryFn: async (): Promise<TextCatalog | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_GET_TEXTS_ACTION,
        input: viewing === null ? {} : { language: viewing },
      })
      const parsed = parseTextCatalog(raw)
      setUnreadable(parsed === null)
      return parsed
    },
  })

  const invalidate = (): void => {
    setDrafts(new Map())
    void queryClient.invalidateQueries({ queryKey: [TEXTS_QUERY_KEY] })
  }

  const setLanguage = useMutation({
    mutationFn: (language: TextLanguage) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_SET_LANGUAGE_ACTION,
        input: { language },
      }),
    onSuccess: invalidate,
  })

  const saveOverrides = useMutation({
    mutationFn: (input: {
      readonly language: TextLanguage
      readonly overrides: Readonly<Record<string, string | null>>
    }) =>
      system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_SET_TEXT_OVERRIDES_ACTION,
        input,
      }),
    onSuccess: invalidate,
  })

  const catalog = catalogQuery.data ?? null
  const shown = useMemo(
    () => (catalog === null ? [] : filterTextEntries(catalog.entries, search)),
    [catalog, search],
  )

  if (catalogQuery.isLoading) {
    return (
      <AdminPage
        embedded
        icon={Languages}
        title={t('system.notificationTexts.texts', 'Texts')}
        subtitle={SUBTITLE}
      >
        <Loader2 className="h-5 w-5 animate-spin" />
      </AdminPage>
    )
  }

  // The DEGRADED state, and the reason it is spelled out rather than left as an
  // empty table: on a hub whose post-analysis addon predates Phase 2 this is
  // the correct, expected answer. "No texts" would read as data loss.
  if (catalogQuery.isError || catalog === null) {
    return (
      <AdminPage
        embedded
        icon={Languages}
        title={t('system.notificationTexts.texts', 'Texts')}
        subtitle={SUBTITLE}
      >
        <ErrorBox
          title={t(
            'system.notificationTexts.theNotificationTextCatalogIs',
            'The notification text catalog is not available on this hub',
          )}
          message={
            unreadable
              ? t(
                  'system.notificationTexts.theHubAnsweredSomethingThis',
                  'The hub answered something this admin build does not understand. Update both and reload.',
                )
              : t(
                  'system.notificationTexts.thisHubHasNotBeen',
                  'This hub has not been updated to serve the notification text catalog yet. Deploy addon-post-analysis and reload — nothing is lost in the meantime: notifications keep using the shipped wording.',
                )
          }
        />
      </AdminPage>
    )
  }

  const language = catalog.language
  const busy = setLanguage.isPending || saveOverrides.isPending
  const patch = buildOverridePatch(catalog.entries, drafts)
  const pending = countPendingEdits(catalog.entries, drafts)
  const overriddenCount = catalog.entries.filter((e) => e.override !== null).length

  const languageOptions = catalog.languages.map((code) => ({
    value: code,
    label: TEXT_LANGUAGE_LABELS[code],
  }))

  const editDraft = (key: string, value: string): void =>
    setDrafts((prev) => new Map(prev).set(key, value))

  const resetRow = (entry: TextEntry): void => editDraft(entry.key, entry.shipped)

  return (
    <AdminPage
      embedded
      icon={Languages}
      title={t('system.notificationTexts.texts', 'Texts')}
      subtitle={SUBTITLE}
    >
      <div className="flex flex-col gap-4">
        {setLanguage.isError ? (
          <ErrorBox
            title={t(
              'system.notificationTexts.couldNotChangeTheLanguage',
              'Could not change the language',
            )}
            message={String(setLanguage.error)}
          />
        ) : null}
        {saveOverrides.isError ? (
          <ErrorBox
            title={t('system.notificationTexts.couldNotSave', 'Could not save')}
            message={String(saveOverrides.error)}
          />
        ) : null}

        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-6">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('system.notificationTexts.hubLanguage', 'Hub language')}
              </label>
              <div className="w-44">
                <Select
                  value={catalog.activeLanguage}
                  disabled={busy}
                  options={languageOptions}
                  onChange={(e) => {
                    const next = e.target.value
                    if (isTextLanguage(next)) setLanguage.mutate(next)
                  }}
                  data-testid="texts-hub-language"
                />
              </div>
              <p className="text-xs text-foreground-subtle">
                {t(
                  'system.notificationTexts.everyNotificationIsWrittenIn',
                  'Every notification is written in this language.',
                )}
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">
                {t('system.notificationTexts.editing', 'Editing')}
              </label>
              <div className="w-44">
                <Select
                  value={language}
                  disabled={busy}
                  options={languageOptions}
                  onChange={(e) => {
                    const next = e.target.value
                    if (!isTextLanguage(next)) return
                    setDrafts(new Map())
                    setViewing(next)
                  }}
                  data-testid="texts-editing-language"
                />
              </div>
              <p className="text-xs text-foreground-subtle">
                {language === catalog.activeLanguage
                  ? t(
                      'system.notificationTexts.ofTextsCustomised',
                      '{{overriddenCount}} of {{length}} texts customised.',
                      { overriddenCount, length: catalog.entries.length },
                    )
                  : t(
                      'system.notificationTexts.thisHubDoesNotSpeak',
                      'This hub does not speak this language — these words are not in use yet.',
                    )}
              </p>
            </div>
          </div>

          <p className="mt-3 text-xs text-foreground-subtle">
            {t(
              'system.notificationTexts.aRuleThatWritesIts',
              'A rule that writes its own title or body still overrides everything here — this page is the wording used when a rule does not.',
            )}
          </p>
        </Card>

        {/* Wraps rather than squeezes: at phone width the search box, the
            "N of M" counter and Save on one row leave the box too narrow to
            type in. Save keeps `ml-auto` so it stays on the right of whichever
            row it lands on. */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-muted" />
            <Input
              value={search}
              placeholder={t(
                'system.notificationTexts.searchAKeyOrA',
                'Search a key or a sentence…',
              )}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7"
              data-testid="texts-search"
            />
          </div>
          <span className="text-xs text-foreground-subtle whitespace-nowrap">
            {shown.length} of {catalog.entries.length}
          </span>
          <Button
            className="ml-auto"
            disabled={busy || pending === 0}
            onClick={() => saveOverrides.mutate({ language, overrides: patch })}
            data-testid="texts-save"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {pending === 0
              ? t('common.save', 'Save')
              : t('system.notificationTexts.save', 'Save {{pending}}', { pending })}
          </Button>
        </div>

        {/* The catalog is one row per printable sentence and grows with every
            text the Notification Center learns to say. It scrolls INSIDE its
            own box so the language pickers, the search and the Save button —
            the three controls that act on what is in view — never leave the
            screen while the operator hunts for a key. */}
        <div
          className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto pr-1"
          data-testid="texts-rows"
        >
          {shown.length === 0 ? (
            <p className="text-sm text-foreground-subtle">
              {t(
                'system.notificationTexts.noTextMatchesThatSearch',
                'No text matches that search.',
              )}
            </p>
          ) : (
            shown.map((entry) => (
              <KeyRow
                key={entry.key}
                entry={entry}
                value={draftValue(entry, drafts)}
                busy={busy}
                onChange={(value) => editDraft(entry.key, value)}
                onReset={() => resetRow(entry)}
              />
            ))
          )}
        </div>
      </div>
    </AdminPage>
  )
}

export default NotificationTextsPage
