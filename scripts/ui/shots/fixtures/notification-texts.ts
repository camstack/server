/**
 * System → Notifications → Texts (`/system/notifications?tab=texts`): the shipped-sentence
 * catalog with one customised key, so the text box and its variable chips render.
 */
import { defineFixtures } from './_define'

const CATALOG = {
  language: 'en',
  activeLanguage: 'en',
  languages: ['en', 'it'],
  entries: [
    {
      key: 'detection.body',
      shipped: '{{subject}} on {{device}}',
      shippedLanguage: 'en',
      override: null,
      effective: '{{subject}} on {{device}}',
      source: 'shipped',
      placeholders: ['subject', 'device'],
      pluralCategories: [],
    },
    {
      key: 'class.person',
      shipped: 'people',
      shippedLanguage: 'en',
      override: 'humans',
      effective: 'humans',
      source: 'override',
      placeholders: [],
      pluralCategories: ['one', 'other'],
    },
  ],
}

export default defineFixtures({
  area: 'notification-texts',
  description: 'Texts tab: a shipped sentence and a customised one',
  handlers: {
    'mut:addons.custom': () => CATALOG,
  },
})
