// Initialise the real i18n instance (English) for every spec, so that
// `t('key', 'Default {{x}}', { x })` interpolates exactly as in the app.
// Without an initialised instance react-i18next returns the raw default and
// leaves `{{x}}` unresolved. Specs that mock `react-i18next` are unaffected.
import '../i18n'
