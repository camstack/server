/**
 * Fixture page for the three Bosch integration forms. Not an admin route:
 * `ui:shots` mounts it when the path is `/bosch-signin/…`.
 */
import { ConfirmDialogProvider, ThemeProvider } from '@camstack/ui-library'
import { ConfigFormBuilder } from '@camstack/ui-library'
import { useState, type ReactElement } from 'react'
import { buildHomeConnectFormSchema } from '../../../../packages/addon-provider-bosch/src/home-connect/config'
import { buildHomeComFormSchema } from '../../../../packages/addon-provider-bosch/src/homecom/config'
import { buildConnectionFormSchema } from '../../../../packages/addon-provider-bosch/src/shc/config'

type FormId = 'homecom' | 'home-connect' | 'shc'

const SCHEMAS = {
  homecom: buildHomeComFormSchema,
  'home-connect': buildHomeConnectFormSchema,
  shc: buildConnectionFormSchema,
} as const

const TITLES: Record<FormId, string> = {
  homecom: 'HomeCom',
  'home-connect': 'Home Connect',
  shc: 'Smart Home Controller',
}

function formIdFromPath(path: string): FormId {
  if (path.endsWith('/home-connect')) return 'home-connect'
  if (path.endsWith('/shc')) return 'shc'
  return 'homecom'
}

export function BoschFormsPreview(): ReactElement {
  const id = formIdFromPath(window.location.pathname)
  const schema = SCHEMAS[id]()
  const [values, setValues] = useState<Record<string, unknown>>({})
  return (
    <ThemeProvider>
      <ConfirmDialogProvider>
        <main className="min-h-screen bg-background p-4 text-foreground">
          <h1 className="mb-3 text-sm font-semibold">{TITLES[id]}</h1>
          <ConfigFormBuilder schema={schema} values={values} onChange={setValues} />
        </main>
      </ConfirmDialogProvider>
    </ThemeProvider>
  )
}
