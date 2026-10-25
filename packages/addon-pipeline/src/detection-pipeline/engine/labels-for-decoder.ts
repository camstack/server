import type { PostprocessorType } from '@camstack/types'

/** Labels forwarded to the Python pool — SSD stock Coral keeps COCO-90 in Python. */
export function labelsForDecoder(
  postprocessor: PostprocessorType,
  modelLabels: readonly string[] | undefined,
  stepLabels: readonly string[] | undefined,
): readonly string[] | undefined {
  if (modelLabels !== undefined && modelLabels.length > 0) {
    return modelLabels
  }
  if (postprocessor === 'ssd') {
    return undefined
  }
  return stepLabels
}
