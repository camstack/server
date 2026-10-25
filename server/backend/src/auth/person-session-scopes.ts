/**
 * A person's session (D921, amended 2026-10-24) is decided by its viewer row
 * alone. Grant rows (`device`, `category`, `capability`, `addon`) are the
 * vocabulary of tokens and account links; they never reach the matcher for a
 * person. A person with no viewer row keeps only the session extras (addon
 * routes, own preferences) and is refused every labelled method.
 */
import { capabilityScopesOf, viewerScopeOf, type CredentialScope } from '@camstack/types'

/** A session extra a person keeps. `'*'` is not one: only an admin session carries it. */
function isSessionExtra(scope: CredentialScope): boolean {
  return (
    scope !== '*' &&
    (scope.type === 'share-view' ||
      scope.type === 'addon-routes' ||
      scope.type === 'preferences-self')
  )
}

/** Drop every grant row but the viewer row, if the set holds one. */
export function personSessionScopes(
  scopes: readonly CredentialScope[],
): readonly CredentialScope[] {
  const viewer = viewerScopeOf(capabilityScopesOf(scopes))
  const extras = scopes.filter(isSessionExtra)
  return viewer === null ? extras : [viewer, ...extras]
}
