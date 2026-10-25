import { LoggingService } from '../logging/logging.service'
import { errMsg } from '@camstack/types'

interface NpmSearchResult {
  name: string
  version: string
  description: string
  keywords: string[]
  date: string
  publisher: { username: string }
}

interface AddonSearchResult {
  name: string
  version: string
  description: string
  keywords: string[]
  publishedAt: string
  author: string
  installed: boolean
  installedVersion?: string
}

export class AddonSearchService {
  private cache: { results: NpmSearchResult[]; timestamp: number } | null = null
  private readonly CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

  constructor(private readonly loggingService: LoggingService) {}

  async searchAddons(query?: string): Promise<AddonSearchResult[]> {
    const npmResults = await this.fetchFromNpm()

    // Filter by additional query if provided
    let filtered = npmResults
    if (query) {
      const q = query.toLowerCase()
      filtered = npmResults.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q) ||
          r.keywords?.some((k) => k.toLowerCase().includes(q)),
      )
    }

    // Return without install status — the caller can merge with installed list
    return filtered.map((r) => ({
      name: r.name,
      version: r.version,
      description: r.description ?? '',
      keywords: r.keywords ?? [],
      publishedAt: r.date ?? '',
      author: r.publisher?.username ?? '',
      installed: false, // caller will enrich this
      installedVersion: undefined,
    }))
  }

  private async fetchFromNpm(): Promise<NpmSearchResult[]> {
    // Return from cache if still fresh
    if (this.cache && Date.now() - this.cache.timestamp < this.CACHE_TTL_MS) {
      return this.cache.results
    }

    // npm registry v1 search: packages with BOTH "camstack" and "addon" keywords
    const url =
      'https://registry.npmjs.org/-/v1/search?text=keywords:camstack+keywords:addon&size=250'

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        throw new Error(`npm search failed: ${response.status}`)
      }

      const data = (await response.json()) as { objects: Array<{ package: NpmSearchResult }> }
      const results = data.objects.map((o) => o.package)

      this.cache = { results, timestamp: Date.now() }

      return results
    } catch (err) {
      const logger = this.loggingService.createLogger('addon-search')
      logger.warn('npm search failed', { meta: { error: errMsg(err) } })
      // Stale cache is better than nothing on transient network failure
      return this.cache?.results ?? []
    }
  }
}
