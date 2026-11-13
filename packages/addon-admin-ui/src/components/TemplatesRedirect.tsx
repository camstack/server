/**
 * `/system/templates` moved into Build-your-self (`/build?tab=templates`).
 * Old links, bookmarks and the remote modal's "edit layout" link keep working;
 * `?edit=<id>` is carried over so the editor still opens on that template.
 */
import { Navigate, useLocation } from 'react-router-dom'
import { TEMPLATE_EDIT_PARAM } from './remote/EditTemplateButton'

export function templatesRedirectTarget(search: string): string {
  const edit = new URLSearchParams(search).get(TEMPLATE_EDIT_PARAM)
  const next = new URLSearchParams({ tab: 'templates' })
  if (edit !== null) next.set(TEMPLATE_EDIT_PARAM, edit)
  return `/build?${next.toString()}`
}

export function TemplatesRedirect() {
  const { search } = useLocation()
  return <Navigate to={templatesRedirectTarget(search)} replace />
}
