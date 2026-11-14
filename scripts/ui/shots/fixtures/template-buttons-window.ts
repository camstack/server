/**
 * The Buttons → devices automation of `template-buttons`, with its optional
 * "Only when" window filled in: weeknights from 22:00 to 06:00. Invented data.
 */
import { buttonsFixtures } from './template-buttons'

export default buttonsFixtures(
  'template-buttons-window',
  'The Buttons → devices automation limited to weeknights',
  {
    between: { from: { kind: 'clock', hh: 22, mm: 0 }, to: { kind: 'clock', hh: 6, mm: 0 } },
    days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  },
)
