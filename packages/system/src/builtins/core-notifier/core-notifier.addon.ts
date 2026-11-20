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
  errMsg,
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
import { readMemberKinds } from './member-kinds.js'

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
      listMemberKinds: () => readMemberKinds(api),
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
          if (status.success) return status.data.state
          logger.warn('alarm panel status is not readable; the member is skipped', {
            tags: { deviceId },
            meta: { deviceId, error: status.error.message },
          })
          return null
        } catch (err) {
          logger.warn('alarm panel read failed; the member is skipped', {
            tags: { deviceId },
            meta: { deviceId, error: errMsg(err) },
          })
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
