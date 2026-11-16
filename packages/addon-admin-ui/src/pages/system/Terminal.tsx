/**
 * System → Terminal. Two sub-sections, never one table:
 *
 * - "Terminal devices" (`TerminalDevices`): Terminal instances — programs kept
 *   open on a node and exported as live cameras — and their live sessions.
 * - "Node shells" (`NodeShells`): one entry per node; a node's login shell
 *   starts only when an admin opens that node's section, and ends when the
 *   section is left or sits idle.
 *
 * Admin-only: every capability method is `auth: 'admin'` and the route is
 * wrapped in `<ProtectedRoute requireAdmin>` in App.tsx.
 */
import { Cable, Terminal as TerminalIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { AdminTabs } from '../../components/AdminTabs'
import { NODE_SHELL_PARAM, NodeShells } from './terminal/NodeShells'
import { TerminalDevices } from './terminal/TerminalDevices'

export const TERMINAL_TAB_DEVICES = 'devices'
export const TERMINAL_TAB_SHELLS = 'shells'

export function TerminalPage() {
  const { t } = useTranslation()
  return (
    <AdminPage
      icon={TerminalIcon}
      title={t('systemPage.terminal.terminal', 'Terminal')}
      subtitle={t(
        'terminalPage.subtitleSections',
        'Keep terminals open as live cameras, or open a shell on a node.',
      )}
    >
      <AdminTabs
        tabs={[
          {
            id: TERMINAL_TAB_DEVICES,
            label: t('terminalPage.tabDevices', 'Terminal devices'),
            icon: Cable,
            content: <TerminalDevices />,
          },
          {
            id: TERMINAL_TAB_SHELLS,
            label: t('terminalPage.tabShells', 'Node shells'),
            icon: TerminalIcon,
            content: <NodeShells />,
            ownedParams: [NODE_SHELL_PARAM],
          },
        ]}
      />
    </AdminPage>
  )
}
