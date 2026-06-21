/**
 * License gate for the SplatWalk Pro tier (`@splatwalk/core-pro`).
 *
 * SCAFFOLD: this is the intended public surface and runtime-gate pattern (modeled
 * on MUI X's `setLicenseKey`). Real key verification (signature/expiry/scope) is
 * intentionally stubbed until the first Pro feature ships - see the TODO below.
 *
 * The free `@splatwalk/core` package never imports this; Pro entry points call
 * `requireProLicense()` before doing work.
 */

let licenseKey: string | null = null;

/** Register the paid license key (typically once at app startup). */
export function setLicenseKey(key: string): void {
  licenseKey = key && key.trim() ? key.trim() : null;
}

/** The currently registered license key, or `null` if none has been set. */
export function getLicenseKey(): string | null {
  return licenseKey;
}

export type LicenseStatus = 'valid' | 'missing' | 'invalid' | 'expired';

/**
 * Inspect the current license without throwing.
 *
 * TODO(pro): replace the presence check with real verification (signed payload,
 * expiry, and feature/scope claims) when the first Pro feature lands.
 */
export function checkLicense(): LicenseStatus {
  if (!licenseKey) return 'missing';
  // Placeholder: any non-empty key is treated as valid in the scaffold.
  return 'valid';
}

/**
 * Guard a Pro entry point. Throws a clear, actionable error when no valid license
 * is present so integrators fail fast at the call site.
 */
export function requireProLicense(feature: string): void {
  const status = checkLicense();
  if (status === 'valid') return;
  throw new Error(
    `[@splatwalk/core-pro] "${feature}" requires a commercial license ` +
      `(status: ${status}). Call setLicenseKey(key) before using Pro features. ` +
      `The free @splatwalk/core has no such requirement. See COMMERCIAL-LICENSE.md.`
  );
}
