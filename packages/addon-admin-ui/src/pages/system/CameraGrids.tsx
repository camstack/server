/**
 * Camera grids page: an `<InstancesTable>` over `camera-grid-layout`. A grid is an
 * `integration-instances` record created here with a name; the table owns the list, the switch
 * and the editor. The layout (cells, frame rate, published profiles) is laid out afterwards in
 * the grid camera's own device details.
 */
import { LayoutGrid } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { InstancesTable } from '../../components/instances/InstancesTable'

export function CameraGridsPage(): ReactElement {
  const { t } = useTranslation()
  return (
    <InstancesTable
      functionCap="camera-grid-layout"
      icon={LayoutGrid}
      title={t('cameraGrids.title', 'Camera grids')}
      subtitle={t(
        'cameraGrids.subtitle',
        'A grid is a composite camera: several cameras composed into one picture, recorded and played back like any other. Create one with a name, then open its camera to lay it out.',
      )}
      emptyTitle={t('cameraGrids.empty', 'No camera grids yet')}
      emptyDescription={t(
        'cameraGrids.emptyHint',
        'Add a grid to compose several cameras into one.',
      )}
      addLabel={t('cameraGrids.add', 'Add grid')}
    />
  )
}
