import { declareLinkKind, defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'
import { GOOGLE_BROKER_KIND, GoogleBrokerEntrySchema, GoogleSessionSchema } from './google-types.js'

export const GOOGLE_BROKERS_OWNER = 'google-services'

export const GoogleBrokerBodySchema = entryBody({
  clientId: GoogleBrokerEntrySchema.shape.clientId,
  clientSecret: GoogleBrokerEntrySchema.shape.clientSecret,
  calendarFilter: GoogleBrokerEntrySchema.shape.calendarFilter,
  fromAddress: GoogleBrokerEntrySchema.shape.fromAddress,
  fromName: GoogleBrokerEntrySchema.shape.fromName,
  // The OAuth session of the account (planning#480): the refresh token is a keychain marker on
  // this record, never a value; the short-lived access token is kept in memory only.
  refreshToken: GoogleSessionSchema.shape.refreshToken,
  accountEmail: GoogleSessionSchema.shape.accountEmail,
  scopes: GoogleSessionSchema.shape.scopes,
  needsReauth: GoogleSessionSchema.shape.needsReauth,
})
export type GoogleBrokerBody = z.infer<typeof GoogleBrokerBodySchema>

export const googleBrokersEntryKind = defineEntryKind('brokers', {
  title: 'Google brokers',
  schema: GoogleBrokerBodySchema,
  writeTrigger: 'an operator adds or edits a Google OAuth broker',
})

/**
 * One calendar an account imports (D1013): a record that LINKS to the account it belongs to and
 * names the Google calendar by its own id (`primary`, `name@group.calendar.google.com`). The id the
 * calendar answers to elsewhere stays `<accountId>:<calendarId>` (`stampCalendarId`).
 */
export const googleCalendarsEntryKind = declareLinkKind({
  name: 'calendars',
  title: 'Google calendars',
  writeTrigger: 'an operator adds or removes a calendar an account imports',
  links: { accountId: { cap: 'broker', kind: GOOGLE_BROKER_KIND } },
  fields: { calendarId: z.string().default('') },
})
export type GoogleCalendarBody = z.infer<typeof googleCalendarsEntryKind.schema>
