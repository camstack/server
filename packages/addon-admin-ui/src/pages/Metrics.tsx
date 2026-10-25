import { IntegrationUsage } from '../components/metrics/IntegrationUsage'
import { ProcessResources } from '../components/metrics/ProcessResources'
import { AgentLoad } from '../components/metrics/AgentLoad'
import { AdminPage } from '../components/AdminPage'

export function MetricsPage() {
  return (
    <AdminPage>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IntegrationUsage />
        <ProcessResources />
        <AgentLoad />
      </div>
    </AdminPage>
  )
}
