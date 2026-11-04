import type { ConfigOption } from '@camstack/types'

// The operator picks ONE source-stream slot for Alexa. Options are the three camstack profile
// slots (`high`/`mid`/`low`) plus the smart `auto` default - NOT raw native camStream ids. The
// runtime picker (`pickPreferredRtspEntry`) translates the choice to a broker brokerId at
// session start, falling back to the closest-resolution slot when `auto` is selected.

export const STREAM_PREFERENCE_OPTIONS: readonly ConfigOption[] = [
  { value: 'auto', label: 'Auto (closest to 720p)' },
  { value: 'high', label: 'High' },
  { value: 'mid', label: 'Mid' },
  { value: 'low', label: 'Low' },
]
