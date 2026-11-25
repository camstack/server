/**
 * The Benchmark page as an app in the shell drawer (`app-source`, D1096,
 * planning#734). Admin-only: the aggregator drops it for any other caller,
 * server side. The entry is the same addon page the standalone admin mounts at
 * `/addon/benchmark`.
 */
import type { AppDeclaration, IAppSourceProvider } from '@camstack/types'

export const BENCHMARK_APP_ID = 'benchmark'

export function buildBenchmarkApp(): AppDeclaration {
  return {
    id: BENCHMARK_APP_ID,
    label: { key: 'apps.benchmark', fallback: 'Benchmark' },
    icon: 'gauge',
    order: 30,
    entry: { kind: 'addon-page', pageId: BENCHMARK_APP_ID },
    reach: { kind: 'hub' },
    adminOnly: true,
    nav: [
      {
        id: BENCHMARK_APP_ID,
        label: null,
        items: [
          {
            id: BENCHMARK_APP_ID,
            label: { key: 'apps.benchmark', fallback: 'Benchmark' },
            icon: 'gauge',
            path: '/addon/benchmark',
          },
        ],
      },
    ],
    takesSharedSearch: false,
    settings: null,
  }
}

export function createBenchmarkAppSourceProvider(): IAppSourceProvider {
  return { listApps: async () => [buildBenchmarkApp()] }
}
