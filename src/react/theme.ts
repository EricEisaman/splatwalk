import { createTheme } from '@mui/material/styles';

/**
 * Cyber-neon MUI theme mirroring the Vuetify showcase palette
 * (see `src/plugins/vuetify.ts` and the CSS custom properties in
 * `src/styles.css`), so the React (R3F) demo shares the SplatWalk look.
 */
export const cyberTheme = createTheme({
  palette: {
    mode: 'dark',
    background: {
      default: '#050505',
      paper: '#111111',
    },
    primary: { main: '#00f0ff' },
    secondary: { main: '#ff0099' },
    success: { main: '#39ff14' },
    warning: { main: '#ffaa00' },
    error: { main: '#ff0099' },
    info: { main: '#00f0ff' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily:
      '"Inter", "Roboto", "Helvetica", "Arial", system-ui, sans-serif',
  },
  components: {
    MuiButton: {
      defaultProps: { variant: 'contained', disableElevation: true },
      styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } },
    },
  },
});
