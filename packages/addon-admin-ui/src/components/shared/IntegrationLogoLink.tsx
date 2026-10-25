import { useNavigate } from 'react-router-dom'
import { ProviderIcon } from './ProviderIcon'

/**
 * The integration logo on a device page, as the LINK it reads as. Clicking
 * it opens the integration that owns the device; while that integration is
 * not yet resolved it opens the list, never a dead click.
 */
interface IntegrationLogoLinkProps {
  readonly provider: string
  readonly integrationId: string | null
  readonly name: string | null
}

export function IntegrationLogoLink({ provider, integrationId, name }: IntegrationLogoLinkProps) {
  const navigate = useNavigate()
  const target = integrationId !== null ? `/integrations/${integrationId}` : '/integrations'
  const label = name !== null ? `Open integration ${name}` : 'Open integrations'
  return (
    <button
      type="button"
      onClick={() => navigate(target)}
      className="shrink-0 rounded-md transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      title={label}
      aria-label={label}
    >
      <ProviderIcon type={provider} size="lg" />
    </button>
  )
}
