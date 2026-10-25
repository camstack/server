import { ReplTerminal } from '../../components/shared/ReplTerminal'
import { AdminPage } from '../../components/AdminPage'

export function ReplPage() {
  return (
    <AdminPage>
      <ReplTerminal
        scope={{ type: 'system' }}
        greeting="CamStack REPL — system console"
        className="min-h-[400px]"
      />
    </AdminPage>
  )
}
