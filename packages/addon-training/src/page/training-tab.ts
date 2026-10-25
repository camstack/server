/** Top-level Training page tabs (`?tab=`). */
export type TrainingTab = 'frames' | 'jobs' | 'providers'

export function readTrainingTab(search: string): TrainingTab {
  const tab = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('tab')
  if (tab === 'jobs' || tab === 'providers' || tab === 'frames') return tab
  return 'frames'
}
