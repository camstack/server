/**
 * Core notifier — owns the `group` notification target (D1071).
 *
 * A group is a target like any other: an instance of `notification-output` of the record kind
 * `notify-group`, listed with the other targets, usable by a notification rule and by the automation
 * "Send notification" step. Delivering to it is one `notificationOutput.send` per member, under the
 * member's own policy. It keeps no credentials: members keep theirs.
 */
import { randomUUID } from 'node:crypto'
import {
  type AddonInitResult,
  AlarmPanelStatusSchema,
  BaseAddon,
  buildNotificationTargetInstances,
  integrationInstancesCapability,
  listNotificationTargets,
  NOTIFIER_GROUP_ADDON_ID,
  NotificationTargetStore,
  notificationOutputCapability,
} from '@camstack/types'
import { EMPTY_GROUP_CAPS, groupRecordKinds, groupTargetKind } from './group-descriptor.js'
import { groupInstancesSpec } from './group-instances.js'
import { createGroupNotificationOutputProvider } from './group-notification-output.js'
import { MemberLedger } from './member-ledger.js'

export class CoreNotifierAddon extends BaseAddon {
  readonly id = NOTIFIER_GROUP_ADDON_ID

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult> {
    const records = this.ctx.records
    const api = this.ctx.api
    if (records === undefined) throw new Error('core-notifier needs ctx.records on the hub')
    if (api === undefined) throw new Error('core-notifier needs ctx.api to reach its members')
    await records.declare(groupRecordKinds)
    const logger = this.ctx.logger.child('notification-output')
    const store = NotificationTargetStore.of(
      records,
      NOTIFIER_GROUP_ADDON_ID,
      groupRecordKinds,
      [groupTargetKind(EMPTY_GROUP_CAPS)],
      { logger },
    )
    const group = createGroupNotificationOutputProvider({
      store,
      listTargets: () => listNotificationTargets(api),
      listMemberKinds: async () => {
        const kinds = await api.notificationOutput.listTargetKinds.query({})
        return kinds
          .filter((kind) => kind.addonId !== NOTIFIER_GROUP_ADDON_ID)
          .map((kind) => ({ kind: kind.kind, caps: kind.caps }))
      },
      sendToMember: (input) =>
        api.notificationOutput.send.mutate({
          addonId: input.addonId,
          targetId: input.targetId,
          notification: input.notification,
        }),
      readAlarmState: async (deviceId) => {
        try {
          const status = AlarmPanelStatusSchema.safeParse(
            await api.alarmPanel.getStatus.query({ deviceId }),
          )
          return status.success ? status.data.state : null
        } catch {
          return null
        }
      },
      ledger: new MemberLedger({ now: () => Date.now() }),
      now: () => Date.now(),
      logger,
    })
    const instances = buildNotificationTargetInstances(
      records,
      groupInstancesSpec({
        mintId: () => randomUUID(),
        knownGroupIds: group.knownGroupIds,
      }),
    )
    this.ctx.logger.info('CoreNotifier initialized')
    return {
      providers: [
        { capability: notificationOutputCapability, provider: group.provider },
        { capability: integrationInstancesCapability, provider: instances },
      ],
    }
  }
}

export default CoreNotifierAddon
