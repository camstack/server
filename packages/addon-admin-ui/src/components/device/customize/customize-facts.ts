/**
 * The facts the Customize tab reads, each as a `Known<…>` (D315): an
 * unanswered query is `pending`, a failed one `unknown` with its reason, and
 * only an answer is `known`.
 */
import { type Known, knownOf, type QueryErrorLike, type QueryLike } from './known'
import type { WireableCatalog } from './source-picker-model'

export type { QueryErrorLike, QueryLike }
export { knownOf }

export interface CustomizeFacts {
  readonly deviceType: string
  /** `listComposableCaps` for the device type. */
  readonly composable: Known<ReadonlySet<string>>
  /** Caps the device serves itself (`getBindings`). */
  readonly nativeCaps: Known<ReadonlySet<string>>
  readonly wireable: Known<WireableCatalog>
  /** Caps the customization composes. */
  readonly composed: ReadonlySet<string>
}
