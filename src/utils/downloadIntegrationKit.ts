/**
 * Trigger download of a prebuilt FastNav / Storage integration kit from
 * `/integration-kits/`. Kits are produced by `npm run build:kits`.
 */

export type IntegrationKitId =
  | 'vuetify'
  | 'r3f'
  | 'storage-adapter'
  | 'babylon-workbench';

const KIT_FILES: Record<IntegrationKitId, { readonly filename: string; readonly href: string }> = {
  vuetify: {
    filename: 'splatwalk-fastnav-vuetify.zip',
    href: '/integration-kits/splatwalk-fastnav-vuetify.zip',
  },
  r3f: {
    filename: 'splatwalk-fastnav-r3f.zip',
    href: '/integration-kits/splatwalk-fastnav-r3f.zip',
  },
  'storage-adapter': {
    filename: 'splatwalk-storage-adapter.zip',
    href: '/integration-kits/splatwalk-storage-adapter.zip',
  },
  'babylon-workbench': {
    filename: 'splatwalk-fastnav-babylon-workbench.zip',
    href: '/integration-kits/splatwalk-fastnav-babylon-workbench.zip',
  },
};

/**
 * Start a browser download for the named integration kit.
 * @param kitId - Kit identifier matching `scripts/build-integration-kits.mjs`
 */
export const downloadIntegrationKit = (kitId: IntegrationKitId): void => {
  const kit = KIT_FILES[kitId];
  const anchor = document.createElement('a');
  anchor.href = kit.href;
  anchor.download = kit.filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};
