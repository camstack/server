/**
 * /build/compositions/new and /build/compositions/:blockId (D676, D941).
 */
import { Boxes } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AdminPage } from '../components/AdminPage'
import { CompositionBlockEditor } from '../components/composition-editor/CompositionBlockEditor'
import { CompositionCreateForm } from '../components/composition-editor/CompositionCreateForm'
import { EDITOR_SHELL_SURFACE } from '../components/composition-editor/editor-surface'
import { BUILD_CUSTOM_DEVICE_PATH, customizePath } from '../lib/customization-routes'
import { coreBlockComposition } from '@camstack/types'
import { Button, useCoreBlocksGetComposition } from '@camstack/ui-library'

const NEW_BLOCK_SEGMENT = 'new'

export function CompositionEditorPage(): ReactNode {
  const { blockId } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const isNew = blockId === undefined || blockId === NEW_BLOCK_SEGMENT
  const read = useCoreBlocksGetComposition({ blockId: blockId ?? '' }, { enabled: !isNew })

  const page = (body: ReactNode): ReactNode => (
    <AdminPage icon={Boxes} title={t('compositionEditor.pageTitle')}>
      {body}
    </AdminPage>
  )

  if (isNew) {
    return page(
      <section className={`${EDITOR_SHELL_SURFACE} flex flex-col gap-2`}>
        <CompositionCreateForm />
      </section>,
    )
  }

  if (read.status === 'success' && read.data.state === 'loaded' && read.data.view !== null) {
    const view = read.data.view
    const composition = coreBlockComposition(view.block)
    if (composition?.target.kind === 'existing') {
      const deviceId = view.state.kind === 'answered' ? (view.state.state?.deviceId ?? null) : null
      if (deviceId !== null) {
        return page(
          <section className={EDITOR_SHELL_SURFACE}>
            <Link className="text-primary text-sm" to={customizePath(deviceId)}>
              {t('compositionEditor.openOnDevice')}
            </Link>
          </section>,
        )
      }
    }
  }

  return page(
    <section className={`${EDITOR_SHELL_SURFACE} flex flex-col gap-2`}>
      <Button variant="ghost" size="sm" onClick={() => navigate(BUILD_CUSTOM_DEVICE_PATH)}>
        {t('compositionEditor.cancel')}
      </Button>
      <CompositionBlockEditor blockId={blockId ?? ''} />
    </section>,
  )
}
