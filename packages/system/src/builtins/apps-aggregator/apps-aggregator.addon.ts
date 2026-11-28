/**
 * Apps Aggregator — hub-local builtin that owns the singleton `apps` cap (D1096).
 *
 * Walks every `app-source` (collection) provider, stamps each app with the
 * provider's addon id and filters by the caller's role. The shell reads it; no
 * app id is spelled anywhere else.
 */
import {
  BaseAddon,
  appsCapability,
  type AppDeclaration,
  type AppInfo,
  type AppNavBadge,
  type IAppsAggregatorProvider,
  type ProviderRegistration,
} from '@dominevo/types'
import { aggregateApps, type AppSourceEntry } from './aggregate-apps.js'

export class AppsAggregatorAddon extends BaseAddon {
  readonly id = 'apps-aggregator'

  /** Last good declarations per source, the fallback for a transient failure. */
  private readonly lastGood = new Map<string, readonly AppDeclaration[]>()

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const provider: IAppsAggregatorProvider = {
      listApps: async (input): Promise<readonly AppInfo[]> => {
        const sources = this.capabilities?.getCollection<AppSourceEntry>('app-source') ?? []
        return aggregateApps(sources, input.caller, this.ctx.logger, this.lastGood)
      },
      // Badges follow after the shell lands (D1096); an honest empty answer.
      getNavBadges: async (): Promise<Record<string, AppNavBadge>> => ({}),
    }
    this.ctx.logger.info('Initialized — aggregating app-source providers')
    return [{ capability: appsCapability, provider }]
  }
}

export default AppsAggregatorAddon
