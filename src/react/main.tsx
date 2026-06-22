import React from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';

import App from '@/react/App';
import { cyberTheme } from '@/react/theme';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app mount node in react.html');
}

createRoot(container).render(
  <React.StrictMode>
    <ThemeProvider theme={cyberTheme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
