/**
 * The "Fetch now" control a waste source row adds to the shared instances table: it asks the
 * waste addon to re-read that one source's calendar (the `fetchNow` custom action) and says what
 * came back. Other calendar providers' rows get none.
 */
import { Button, IconButton, useAlert, useAddonsCustom } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { HOLDER_QUERY_KEY } from '../instances/use-instances-data'
import type { InstanceRow } from '../instances/instances-model'

/** Fixed: no descriptor says which provider owns a per-row fetch action; only this addon has one. */
const WASTE_ADDON_ID = 'waste-collections'

const FetchNowResultSchema = z.object({
  refreshed: z.array(
    z.object({
      sourceId: z.string(),
      entryCount: z.number().int(),
      error: z.string().optional(),
    }),
  ),
})

function WasteFetchNowButton({ row }: { readonly row: InstanceRow }): ReactElement {
  const { t } = useTranslation()
  const alert = useAlert()
  const queryClient = useQueryClient()
  const run = useAddonsCustom({
    onSuccess: async (raw) => {
      const parsed = FetchNowResultSchema.safeParse(raw)
      const outcome = parsed.success ? parsed.data.refreshed[0] : undefined
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      if (outcome === undefined) {
        await alert({
          title: t('wasteFetchNow.nothingFetched', 'Nothing to fetch'),
          message: t(
            'wasteFetchNow.sourceIsOff',
            '{{name}} is switched off, so it was not fetched.',
            { name: row.name },
          ),
        })
        return
      }
      await alert({
        title:
          outcome.error === undefined
            ? t('wasteFetchNow.fetched', '{{name}} fetched', { name: row.name })
            : t('wasteFetchNow.failed', '{{name}} could not be fetched', { name: row.name }),
        message:
          outcome.error ??
          t('wasteFetchNow.collections', '{{count}} collections read.', {
            count: outcome.entryCount,
          }),
        variant: outcome.error === undefined ? 'default' : 'danger',
      })
    },
    onError: async (err) => {
      await alert({
        title: t('wasteFetchNow.failed', '{{name}} could not be fetched', { name: row.name }),
        message: err.message,
        variant: 'danger',
      })
    },
  })
  return (
    <IconButton
      icon={Download}
      variant="ghost"
      size="sm"
      aria-label={t('wasteFetchNow.label', 'Fetch {{name}} now', { name: row.name })}
      disabled={run.isPending}
      onClick={() =>
        run.mutate({
          addonId: WASTE_ADDON_ID,
          action: 'fetchNow',
          input: { sourceId: row.id },
        })
      }
    />
  )
}

/** The row action of the calendars table: a fetch button on a waste source, nothing elsewhere. */
export function wasteFetchNowAction(row: InstanceRow): ReactElement | null {
  return row.addonId === WASTE_ADDON_ID ? <WasteFetchNowButton row={row} /> : null
}

/**
 * The page action beside Add: refresh every enabled waste source at once (the `fetchNow` action
 * with no source id). It is the control the addon's settings form used to carry; drawn only
 * while a waste source exists, so another calendar provider's page shows nothing.
 */
function WasteFetchAllButton(): ReactElement {
  const { t } = useTranslation()
  const alert = useAlert()
  const queryClient = useQueryClient()
  const run = useAddonsCustom({
    onSuccess: async (raw) => {
      const parsed = FetchNowResultSchema.safeParse(raw)
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      const refreshed = parsed.success ? parsed.data.refreshed : []
      const failed = refreshed.filter((outcome) => outcome.error !== undefined)
      await alert({
        title:
          failed.length === 0
            ? t('wasteFetchNow.allFetched', 'Calendars fetched')
            : t('wasteFetchNow.allFailed', '{{count}} calendars could not be fetched', {
                count: failed.length,
              }),
        message:
          failed.length === 0
            ? t('wasteFetchNow.allCollections', '{{count}} sources refreshed.', {
                count: refreshed.length,
              })
            : failed.map((outcome) => `${outcome.sourceId}: ${outcome.error}`).join('\n'),
        variant: failed.length === 0 ? 'default' : 'danger',
      })
    },
    onError: async (err) => {
      await alert({
        title: t('wasteFetchNow.allNotFetched', 'The calendars could not be fetched'),
        message: err.message,
        variant: 'danger',
      })
    },
  })
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={run.isPending}
      onClick={() => run.mutate({ addonId: WASTE_ADDON_ID, action: 'fetchNow', input: {} })}
    >
      <Download className="h-3.5 w-3.5" />
      {t('wasteFetchNow.all', 'Fetch all now')}
    </Button>
  )
}

/** The page action of the calendars table: fetch every waste source, nothing without one. */
export function wasteFetchAllAction(rows: readonly InstanceRow[]): ReactElement | null {
  return rows.some((row) => row.addonId === WASTE_ADDON_ID) ? <WasteFetchAllButton /> : null
}
