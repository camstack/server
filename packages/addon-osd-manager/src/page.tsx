/// <reference types="vite/client" />
import './index.css'
import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  ErrorBox,
  mountAddonPage,
  SectionedPage,
  useUrlQueryParam,
  type AddonPageProps,
  type PickerDevice,
  useDeviceManagerGetAllBindings,
  useDeviceManagerListAll,
  useOsdManagerListTemplates,
} from '@camstack/ui-library'
import { Loader2, Monitor, Plus } from 'lucide-react'
import { CameraOsdTable } from './components/CameraOsdTable.js'
import { TemplatesPanel } from './components/TemplatesPanel.js'
import { useT } from './i18n/index.js'
import { toOsdPickerDevices } from './osd-picker-devices.js'

type PageTab = 'cameras' | 'templates'

function parsePageTab(raw: string | null): PageTab {
  return raw === 'templates' ? 'templates' : 'cameras'
}

/**
 * OSD Manager — federated Detection page.
 *
 * Shell is library `SectionedPage` with `fill` (table owns the scroll).
 * "New template" lives in the page header when Templates is active (Build /
 * Integrations pattern). Cameras / Templates are DataTable + ItemFormDialog.
 */
export default function OsdManagerPage(_props: AddonPageProps) {
  const { t } = useT()
  const [tabParam, setTabParam] = useUrlQueryParam('tab')
  const [, setDeviceParam] = useUrlQueryParam('device')
  const [, setSlotParam] = useUrlQueryParam('slot')
  const [, setPanelParam] = useUrlQueryParam('panel')
  const [, setEditParam] = useUrlQueryParam('edit')
  const [, setNewParam] = useUrlQueryParam('new')
  const tab = parsePageTab(tabParam)
  const [createRequested, setCreateRequested] = useState(false)

  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' })
  const bindingsQuery = useDeviceManagerGetAllBindings({})
  const templatesQuery = useOsdManagerListTemplates({})

  const cameras = useMemo(() => {
    return (devicesQuery.data ?? [])
      .filter((device) => device.isCamera)
      .map((device) => ({ id: device.id, name: device.name }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  }, [devicesQuery.data])

  const allDevices = useMemo(
    () => (devicesQuery.data ?? []).map((d) => ({ id: d.id, name: d.name })),
    [devicesQuery.data],
  )

  const pickerDevices: PickerDevice[] = useMemo(
    () => toOsdPickerDevices(devicesQuery.data ?? []),
    [devicesQuery.data],
  )

  const listState = devicesQuery.isError
    ? 'failed'
    : devicesQuery.isSuccess
      ? 'answered'
      : 'pending'

  const osdCapableIds = useMemo(
    () =>
      new Set(
        (bindingsQuery.data ?? [])
          .filter((binding) => binding.entries.some((entry) => entry.capName === 'osd'))
          .map((binding) => binding.deviceId),
      ),
    [bindingsQuery.data],
  )
  const loadError = devicesQuery.error ?? bindingsQuery.error ?? templatesQuery.error
  const loading = devicesQuery.isLoading || bindingsQuery.isLoading
  const subtitle = loading
    ? t('page.loadingCameras')
    : t('page.subtitle', {
        cameras: cameras.length,
        writable: osdCapableIds.size,
        templates: templatesQuery.data?.templates.length ?? 0,
      })

  const onSectionChange = useCallback(
    (id: string, ownedParamsToClear: readonly string[]): void => {
      for (const key of ownedParamsToClear) {
        if (key === 'device') setDeviceParam(null)
        else if (key === 'slot') setSlotParam(null)
        else if (key === 'panel') setPanelParam(null)
        else if (key === 'edit') setEditParam(null)
        else if (key === 'new') setNewParam(null)
      }
      setTabParam(id === 'cameras' ? null : id)
    },
    [setDeviceParam, setEditParam, setNewParam, setPanelParam, setSlotParam, setTabParam],
  )

  const camerasBody = loading ? (
    <div className="flex flex-1 items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  ) : loadError ? (
    <ErrorBox message={loadError.message} title={t('page.loadFailed')} />
  ) : cameras.length === 0 ? (
    <div className="flex flex-1 items-center justify-center py-16 text-xs text-foreground-subtle">
      {t('table.noCameras')}
    </div>
  ) : (
    <CameraOsdTable
      cameras={cameras}
      osdCapableIds={osdCapableIds}
      allDevices={allDevices}
      pickerDevices={pickerDevices}
      listState={listState}
      templates={templatesQuery.data?.templates ?? []}
    />
  )

  return (
    <SectionedPage
      icon={Monitor}
      title={t('page.title')}
      subtitle={subtitle}
      defaultSection="cameras"
      sectionsLabel={t('page.sectionsLabel')}
      fill
      activeSection={tab}
      onSectionChange={onSectionChange}
      actions={
        tab === 'templates' ? (
          <Button
            type="button"
            data-testid="osd-template-new"
            onClick={() => setCreateRequested(true)}
          >
            <Plus className="h-4 w-4" />
            {t('page.newTemplate')}
          </Button>
        ) : undefined
      }
      sections={[
        {
          id: 'cameras',
          label: t('page.tabCameras'),
          ownedParams: ['device', 'slot', 'panel'],
          content: camerasBody,
        },
        {
          id: 'templates',
          label: t('page.tabTemplates'),
          ownedParams: ['edit', 'new', 'panel'],
          content: (
            <TemplatesPanel
              createRequested={createRequested}
              onCreateConsumed={() => setCreateRequested(false)}
            />
          ),
        },
      ]}
    />
  )
}

// ---------------------------------------------------------------------------
// Dev mode: auto-mount when loaded as entry point (not as imported module)
// ---------------------------------------------------------------------------
if (import.meta.env?.DEV && typeof document !== 'undefined' && document.getElementById('root')) {
  mountAddonPage(OsdManagerPage, { title: 'OSD Manager' })
}
