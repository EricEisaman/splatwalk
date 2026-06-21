/**
 * `@splatwalk/core-pro` public entry (SCAFFOLD).
 *
 * Root export surfaces the license gate; feature modules live on subpaths
 * (e.g. `@splatwalk/core-pro/streaming`). Reserved and not yet published.
 */

export {
  setLicenseKey,
  getLicenseKey,
  checkLicense,
  requireProLicense,
  type LicenseStatus,
} from './license';
