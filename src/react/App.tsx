import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import HomeIcon from '@mui/icons-material/Home';
import GitHubIcon from '@mui/icons-material/GitHub';

import { SplatFastNavShowcase } from '@/react/SplatFastNavShowcase';

const GITHUB_URL = 'https://github.com/EricEisaman/splatwalk';

/**
 * React app shell mirroring `src/vuetify/App.vue`: a flat app bar with the
 * SplatWalk / FastNav brand and a Home link, hosting the FAST NAV showcase.
 */
export default function App(): JSX.Element {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={0} color="default" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar>
          <Typography
            variant="h6"
            component="div"
            sx={{ flexGrow: 1, fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase' }}
          >
            <Box component="span" sx={{ color: 'primary.main' }}>
              SplatWalk
            </Box>{' '}
            <Box component="span" sx={{ color: 'secondary.main' }}>
              / FastNav (R3F)
            </Box>
          </Typography>
          <Button href="/" color="primary" variant="text" startIcon={<HomeIcon />}>
            Home
          </Button>
          <Button
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            color="secondary"
            variant="text"
            startIcon={<GitHubIcon />}
          >
            GitHub
          </Button>
        </Toolbar>
      </AppBar>

      <Box component="main">
        <SplatFastNavShowcase />
      </Box>
    </Box>
  );
}
