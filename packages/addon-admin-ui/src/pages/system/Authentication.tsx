/**
 * Authentication page (Identity → Authentication): the sign-in connections are ONE
 * `InstancesTable` over the `login-method` function cap — the same component, pill row, header
 * Add, columns and dialogs as Connectivity → Brokers — and the hub-wide sign-in policy is the one
 * settings card below it.
 *
 * Provider help and settings come from the declaration, never from this page: the provider picker
 * shows the addon's own description, an OpenID Connect record's form carries its setup steps, and a
 * provider that keeps no records (passkeys) is a fixed row of the table with its own Settings
 * dialog and on switch. Local password sign-in is always on; the note in the policy card says so.
 */
import { Globe, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { SECTION_BODY, SectionCard } from "@camstack/ui-library";
import { BootstrapSettingsForm } from "../../components/system/BootstrapSettingsForm";
import { InstancesTable } from "../../components/instances/InstancesTable";
import { INSTANCE_ID_PATTERN } from "../../components/instances/instances-model";

export function AuthenticationPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 sm:space-y-4">
      <InstancesTable
        functionCap="login-method"
        icon={Globe}
        title={t(
          "system.authentication.connectionsTitle",
          "Sign-in connections",
        )}
        subtitle={t(
          "system.authentication.connectionsSubtitle",
          "Identity providers that sign users in. Each connection has its own id, which cannot be changed later.",
        )}
        emptyTitle={t(
          "system.authentication.connectionsEmptyTitle",
          "No sign-in connections",
        )}
        emptyDescription={t(
          "system.authentication.connectionsEmptyDescription",
          "Add a connection to let users sign in through an identity provider.",
        )}
        addLabel={t("system.authentication.addConnection", "Add connection")}
        install={{
          capability: "login-method",
          label: t("system.authentication.sectionInstall", "Add provider"),
        }}
        typedId={() => ({ pattern: INSTANCE_ID_PATTERN })}
      />
      <AuthenticationPolicyCard />
    </div>
  );
}

/**
 * The hub-wide sign-in policy: token lifetimes, trusted proxies, trusted
 * networks and the allowed browser origins. They are the `system-config`
 * addon's `system-config-auth` section, served by its bootstrap-form actions;
 * this is the only place the section is drawn (System → Settings omits it).
 */
export const AUTH_POLICY_SECTION_ID = "system-config-auth";

export function AuthenticationPolicyCard(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <SectionCard
      headingId="authentication-policy"
      title={t("system.authentication.policyTitle", "Sign-in policy")}
      icon={ShieldCheck}
    >
      <div className={SECTION_BODY}>
        <p className="text-xs text-foreground-subtle">
          {t(
            "system.authentication.localAlwaysOn",
            "Username and password sign-in is always on and cannot be turned off. It is not a connection, so it has no row above.",
          )}
        </p>
        <p className="text-xs text-foreground-subtle">
          <Trans
            i18nKey="system.authentication.totpNote"
            components={{
              access: (
                <Link
                  to="/system/my-access?tab=sign-in"
                  className="underline text-primary"
                />
              ),
              users: (
                <Link
                  to="/system/identity?tab=users"
                  className="underline text-primary"
                />
              ),
            }}
          />
        </p>
        <BootstrapSettingsForm
          sectionIds={[AUTH_POLICY_SECTION_ID]}
          hideSectionChrome
          emptyMessage={t(
            "system.authentication.policyUnavailable",
            "Not available — the addon that owns these settings did not answer.",
          )}
        />
      </div>
    </SectionCard>
  );
}

/**
 * The passkey relying-party identity (product name, RP ID, origin, challenge
 * lifetime): the `auth-webauthn` addon's `webauthn` section, same store. Drawn
 * only here — System → Settings omits it.
 */
/**
 * The passkey relying-party section (`webauthn`) of the `auth-webauthn` addon. It is the Settings
 * dialog of the passkey row in the table above; System → Settings leaves it out.
 */
export const WEBAUTHN_SECTION_ID = "webauthn";
