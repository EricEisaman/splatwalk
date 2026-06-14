import { createVuetify } from 'vuetify';
import type { ThemeDefinition } from 'vuetify';

/**
 * Cyber neon theme mirroring the SplatWalk landing page palette
 * (see the CSS custom properties in `src/styles.css`).
 */
const cyberDark: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#050505',
    surface: '#111111',
    'surface-variant': '#1a1a1a',
    'on-surface-variant': '#e0e0e0',
    primary: '#00f0ff',
    secondary: '#ff0099',
    accent: '#bc13fe',
    success: '#39ff14',
    warning: '#ffaa00',
    error: '#ff0099',
    info: '#00f0ff',
  },
};

export const vuetify = createVuetify({
  theme: {
    defaultTheme: 'cyberDark',
    themes: { cyberDark },
  },
  icons: {
    defaultSet: 'mdi',
  },
  defaults: {
    VBtn: {
      variant: 'tonal',
      rounded: 'md',
    },
    VCard: {
      rounded: 'lg',
    },
  },
});
