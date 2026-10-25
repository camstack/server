/**
 * System → Data → Records — ONE section for every stored record: the declared
 * kinds (entry kinds editable, the rest read-only) behind compact filters, and
 * the data left behind by deleted devices as a second view of the same section.
 */
import { DataRecordsHub, SECTION_BODY, Tabs, TabsList, TabsTrigger } from '@camstack/ui-library'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { DeletedDevicesData } from '../../components/system/deleted-devices/DeletedDevicesData'

export const DATA_RECORDS_VIEW_PARAM = 'view'
export const DATA_RECORDS_VIEW_KINDS = 'kinds'
export const DATA_RECORDS_VIEW_DELETED = 'deleted-devices'

export function DataRecordsSection(): JSX.Element {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const view =
    params.get(DATA_RECORDS_VIEW_PARAM) === DATA_RECORDS_VIEW_DELETED
      ? DATA_RECORDS_VIEW_DELETED
      : DATA_RECORDS_VIEW_KINDS

  const selectView = (next: string): void => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev)
        if (next === DATA_RECORDS_VIEW_KINDS) out.delete(DATA_RECORDS_VIEW_PARAM)
        else out.set(DATA_RECORDS_VIEW_PARAM, next)
        return out
      },
      { replace: true },
    )
  }

  return (
    <div className={SECTION_BODY}>
      <div className="mb-3 space-y-2">
        <Tabs appearance="pills" value={view} onValueChange={selectView}>
          <TabsList className="flex flex-wrap gap-1">
            <TabsTrigger value={DATA_RECORDS_VIEW_KINDS}>
              {t('systemPage.data.viewKinds', 'Record kinds')}
            </TabsTrigger>
            <TabsTrigger value={DATA_RECORDS_VIEW_DELETED}>
              {t('systemPage.data.viewDeletedDevices', 'Deleted devices')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {view === DATA_RECORDS_VIEW_KINDS ? (
          <p className="text-xs text-foreground-muted">
            {t(
              'systemPage.data.recordsUnifiedIntro',
              'Every declared record kind on this hub. Entry kinds can be added, edited and deleted; the rest are read-only. Secret fields are redacted.',
            )}
          </p>
        ) : null}
      </div>
      {view === DATA_RECORDS_VIEW_KINDS ? <DataRecordsHub /> : <DeletedDevicesData />}
    </div>
  )
}
