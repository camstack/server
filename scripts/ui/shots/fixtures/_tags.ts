/**
 * The tag registry (D1054) for areas that show tags: `tags.list` names the
 * tags in use — `Garden` and `Night` styled, `Energy` falling back to the colour derived from their name. Invented.
 */
const NO_COUNTS = { coreBlocks: 0, schedulers: 0, templates: 0, actions: 0, devices: 0 }

export const TAG_ENTRIES = [
  { name: 'Garden', color: 'tag-c', icon: 'leaf', styled: true, counts: NO_COUNTS },
  { name: 'Night', color: 'tag-e', icon: 'moon', styled: true, counts: NO_COUNTS },
  { name: 'Energy', color: 'tag-b', icon: 'tag', styled: false, counts: NO_COUNTS },
]

/** The shell already answers the `tags` cap present (D315). */
export const tagHandlers = { 'tags.list': TAG_ENTRIES }
