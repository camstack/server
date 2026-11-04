/**
 * Training providers page — the cloud accounts that run training jobs.
 *
 * A `<InstancesTable>` over `training-provider`: a Modal workspace is one row per
 * `integration-instances` record (token, GPU, cost cap), created from a provider picker.
 * The Training page (`/addon/training`) links here from its Providers tab and reads the
 * enabled accounts back when it plans a job. Nothing about a provider is hard-coded here.
 */
import { ArrowLeft, Cloud } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@camstack/ui-library'
import { AdminPage } from '../../components/AdminPage'
import { InstancesTable } from '../../components/instances/InstancesTable'

/** The Training addon page this one belongs to. */
const TRAINING_PAGE_PATH = '/addon/training?tab=providers'

export function TrainingProvidersPage(): ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <AdminPage
      icon={Cloud}
      title={t('system.trainingProviders.title', 'Training providers')}
      actions={
        <Button size="sm" variant="secondary" onClick={() => navigate(TRAINING_PAGE_PATH)}>
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('system.trainingProviders.backToTraining', 'Back to Training')}
        </Button>
      }
    >
      <InstancesTable
        functionCap="training-provider"
        icon={Cloud}
        title={t('system.trainingProviders.accounts', 'Cloud accounts')}
        subtitle={t(
          'system.trainingProviders.accountsSubtitle',
          'GPU-cloud accounts that run training jobs. Each account keeps its own token, GPU, cost cap and region; credentials stay in the CamStack keychain.',
        )}
        emptyTitle={t('system.trainingProviders.noProviders', 'No training providers installed')}
        emptyDescription={t(
          'system.trainingProviders.noProvidersDescription',
          'Install a training provider addon (for example @camstack/addon-training) to train on your own GPU-cloud account.',
        )}
        addLabel={t('system.trainingProviders.addAccount', 'Add account')}
      />
    </AdminPage>
  )
}
