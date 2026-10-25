/**
 * The first-boot admin password (D728 / D797: `admin` / `changeme`, not
 * configurable). A sign-in with it is forced through the change-password page;
 * that page then sends it as the CURRENT password of the caller's own change,
 * since the forced state was derived from exactly this value.
 */
export const SEED_ADMIN_PASSWORD = 'changeme'
