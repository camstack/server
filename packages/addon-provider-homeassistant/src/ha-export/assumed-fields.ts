/**
 * The fields of a slice its driver only ASSUMES (`assumedFields`: a device with
 * no feedback, tracked from what was last sent). A slice without the list, or
 * with one that is not a list of names, assumes nothing.
 */
export function assumedFieldsOf(
  slice: Readonly<Record<string, unknown>> | undefined,
): ReadonlySet<string> {
  const listed: unknown = slice?.['assumedFields']
  if (!Array.isArray(listed)) return new Set()
  return new Set(listed.filter((name): name is string => typeof name === 'string'))
}
