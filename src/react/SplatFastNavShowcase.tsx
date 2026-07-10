import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Container from '@mui/material/Container';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RefreshIcon from '@mui/icons-material/Refresh';
import ViewInArIcon from '@mui/icons-material/ViewInAr';

import { SceneCanvas } from '@/react/SceneCanvas';
import { DEFAULT_EXAMPLE_SCENES } from '@/react/exampleScenes';
import { useSplatFastNavR3F, type LogTag, type SogExportMode } from '@/react/useSplatFastNavR3F';
import {
  clampSliceSettingsForScene,
  DEFAULT_AUTO_SLICE_THRESHOLD,
  DEFAULT_SLICE_SETTINGS,
} from '@/wasm/sogTypes';

const tagColor: Record<LogTag, 'info' | 'warning' | 'error' | 'success' | 'secondary'> = {
  info: 'info',
  wait: 'warning',
  warn: 'warning',
  error: 'error',
  success: 'success',
  worker: 'secondary',
};

export function SplatFastNavShowcase(): JSX.Element {
  const nav = useSplatFastNavR3F();
  const {
    controller,
    status,
    statusMessage,
    errorMessage,
    setErrorMessage,
    logs,
    isBusy,
    phase,
    progress,
    splatCount,
    maxShDegree,
    maxChunkExtent,
    loadAndProcess,
    loadExample,
    exportNavmesh,
    generateCollisionBoundary,
    exportCollisionMesh,
    setCollisionBoundaryVisible,
    setNavMeshVisible,
    exportSog,
    reset,
  } = nav;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [exampleAnchor, setExampleAnchor] = useState<null | HTMLElement>(null);

  const [sliceForm, setSliceForm] = useState({
    sh_degree: DEFAULT_SLICE_SETTINGS.sh_degree,
    sh_cluster_count: DEFAULT_SLICE_SETTINGS.sh_cluster_count,
    sh_iterations: DEFAULT_SLICE_SETTINGS.sh_iterations,
    chunk_count: DEFAULT_SLICE_SETTINGS.chunk_count,
    chunk_extent: DEFAULT_SLICE_SETTINGS.chunk_extent,
    lod_levels: DEFAULT_SLICE_SETTINGS.lod_levels,
  });
  const isLargeScene = splatCount !== null && splatCount > DEFAULT_AUTO_SLICE_THRESHOLD;
  const [sogMode, setSogMode] = useState<SogExportMode>('streamed');
  const [sogExporting, setSogExporting] = useState(false);
  const [sogSummary, setSogSummary] = useState<string | null>(null);
  const [collisionBoundaryVisible, setCollisionBoundaryVisibleState] = useState(true);
  const [collisionExporting, setCollisionExporting] = useState(false);
  const [collisionSummary, setCollisionSummary] = useState<string | null>(null);
  const [navMeshVisible, setNavMeshVisibleState] = useState(true);
  const [navExporting, setNavExporting] = useState(false);
  const [navSummary, setNavSummary] = useState<string | null>(null);

  useEffect(() => {
    setCollisionSummary(null);
    setNavSummary(null);
    setSogSummary(null);
    setNavMeshVisibleState(true);
    setSogMode(isLargeScene ? 'streamed' : 'single');
  }, [splatCount, isLargeScene]);

  useEffect(() => {
    setSliceForm((prev) => ({
      ...prev,
      sh_degree: Math.min(prev.sh_degree, maxShDegree),
      chunk_extent: Math.min(prev.chunk_extent, maxChunkExtent),
    }));
  }, [maxChunkExtent, maxShDegree]);

  const progressText = useMemo(() => {
    if (!progress) return null;
    const labels: Record<string, string> = {
      parse: 'Parsing splat',
      prune: 'Pruning floaters',
      field: 'Building floor field',
    };
    const baseLabel = labels[progress.stage] ?? 'Processing';
    return progress.fraction !== null ? `${baseLabel} ${Math.round(progress.fraction * 100)}%` : baseLabel;
  }, [progress]);

  const steps = useMemo(() => {
    const loadDone = status === 'processing' || status === 'done';
    const navDone = status === 'done';
    const pruneActive = status === 'processing' && phase === 'prune';
    const pruneDone = phase === 'floor' || phase === 'navmesh' || phase === 'done';
    const navActive = status === 'processing' && (phase === 'floor' || phase === 'navmesh');
    const pruneLabel = pruneActive && progressText ? progressText : 'Prune outliers';
    return [
      { label: 'Load splat', active: status === 'loading', done: loadDone },
      { label: pruneLabel, active: pruneActive, done: pruneDone || navDone },
      { label: 'FAST NAV', active: navActive, done: navDone },
      { label: 'Top-down view', active: false, done: navDone },
    ];
  }, [status, phase, progressText]);

  const sogStatusText = useMemo(() => {
    if (sogSummary) return sogSummary;
    if (splatCount === null) return null;
    return isLargeScene
      ? `${splatCount.toLocaleString()} splats - large scene. Streamed LOD export recommended.`
      : `${splatCount.toLocaleString()} splats. Streamed or single SOG export available.`;
  }, [sogSummary, splatCount, isLargeScene]);

  const showLodLevelsWarning = sogMode === 'streamed' && sliceForm.lod_levels === 1;
  const sogExportButtonLabel =
    sogMode === 'streamed' ? 'Export streamed SOG (.zip)' : 'Export single SOG (.zip)';

  const showDropZone = status === 'idle' || status === 'error';

  const pickFile = useCallback(
    (file: File | null | undefined): void => {
      if (file) void loadAndProcess(file);
    },
    [loadAndProcess]
  );

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    pickFile(event.target.files?.[0]);
    event.target.value = '';
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    pickFile(event.dataTransfer?.files?.[0]);
  };

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const el = cardRef.current;
    if (!el) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  }, []);

  useEffect(() => {
    const onChange = (): void => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const runSogExport = useCallback(async (): Promise<void> => {
    if (sogExporting) return;
    setSogExporting(true);
    setSogSummary(null);
    try {
      const archive = await exportSog(
        sogMode,
        clampSliceSettingsForScene(sliceForm, { maxShDegree, maxChunkExtent })
      );
      const mb = (archive.byteLength / 1e6).toFixed(1);
      setSogSummary(`Exported ${archive.chunkCount} chunk(s), ${archive.fileCount} files (${mb} MB).`);
    } catch (error) {
      setSogSummary(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSogExporting(false);
    }
  }, [exportSog, maxChunkExtent, maxShDegree, sliceForm, sogExporting, sogMode]);

  const runCollisionGenerate = useCallback(async (): Promise<void> => {
    if (collisionExporting) return;
    setCollisionExporting(true);
    setCollisionSummary(null);
    try {
      const artifact = await generateCollisionBoundary();
      setCollisionBoundaryVisibleState(true);
      setCollisionSummary(
        `Collision boundary: ${artifact.result.mesh.vertex_count} vertices, ${artifact.result.mesh.face_count} faces.`
      );
    } catch (error) {
      setCollisionSummary(`Collision generation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCollisionExporting(false);
    }
  }, [collisionExporting, generateCollisionBoundary]);

  const runCollisionExport = useCallback(async (): Promise<void> => {
    if (collisionExporting) return;
    setCollisionExporting(true);
    try {
      const bytes = await exportCollisionMesh();
      setCollisionSummary(`Exported collision mesh (${(bytes.byteLength / 1e6).toFixed(1)} MB).`);
    } catch (error) {
      setCollisionSummary(`Collision export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCollisionExporting(false);
    }
  }, [collisionExporting, exportCollisionMesh]);

  const runNavmeshExport = useCallback(async (): Promise<void> => {
    if (navExporting) return;
    setNavExporting(true);
    try {
      await exportNavmesh();
      setNavSummary('Navmesh export started.');
    } catch (error) {
      setNavSummary(`Navmesh export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNavExporting(false);
    }
  }, [exportNavmesh, navExporting]);

  const numberField = (
    key: keyof typeof sliceForm,
    label: string,
    props: { min?: number; max?: number; step?: number; helperText?: string } = {}
  ): JSX.Element => {
    const { helperText, ...inputProps } = props;
    return (
      <TextField
        type="number"
        size="small"
        fullWidth
        label={label}
        value={sliceForm[key]}
        inputProps={inputProps}
        helperText={helperText}
        FormHelperTextProps={helperText ? { sx: { mx: 0 } } : undefined}
        onChange={(e) => setSliceForm((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
      />
    );
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Grid container justifyContent="center">
        <Grid item xs={12} md={10} lg={9}>
          <Typography variant="h5" sx={{ fontWeight: 900, textTransform: 'uppercase', mb: 1 }}>
            Gaussian Splat <Box component="span" sx={{ color: 'primary.main' }}>FAST NAV</Box>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Drop a <strong>.ply</strong> or <strong>.spz</strong> 3D Gaussian Splat. It renders in React Three
            Fiber, auto-runs the FAST NAV pipeline (floor field &rarr; navmesh &rarr; crowd &rarr; NPC), then frames the
            player top-down. Click the green navmesh to move the player.
          </Typography>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 3 }}>
            {steps.map((step) => (
              <Chip
                key={step.label}
                size="small"
                color={step.done ? 'success' : step.active ? 'primary' : 'default'}
                variant={step.done || step.active ? 'filled' : 'outlined'}
                icon={
                  step.done ? (
                    <CheckCircleIcon />
                  ) : step.active ? (
                    <AutorenewIcon />
                  ) : (
                    <RadioButtonUncheckedIcon />
                  )
                }
                label={step.label}
              />
            ))}
          </Box>

          <Paper
            ref={cardRef}
            variant="outlined"
            onDragEnter={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setIsDragging(false);
            }}
            onDrop={onDrop}
            sx={{
              position: 'relative',
              overflow: 'hidden',
              bgcolor: '#000',
              height: 'clamp(360px, 68vh, 760px)',
              outline: isDragging ? '2px dashed' : 'none',
              outlineColor: 'primary.main',
              outlineOffset: '-6px',
              '&:fullscreen': { height: '100vh', width: '100vw' },
            }}
          >
            <Box sx={{ width: '100%', height: '100%' }}>
              <SceneCanvas controller={controller} />
            </Box>

            {status === 'done' && (
              <IconButton
                onClick={toggleFullscreen}
                color="primary"
                sx={{ position: 'absolute', top: 12, right: 12, bgcolor: 'rgba(0,0,0,0.45)' }}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </IconButton>
            )}

            {showDropZone && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'rgba(5,5,5,0.82)',
                  textAlign: 'center',
                  p: 4,
                }}
              >
                <Box>
                  <CloudUploadIcon sx={{ fontSize: 72, color: 'primary.main', mb: 1.5 }} />
                  <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
                    Drop your splat here
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    .ply or .spz · drag &amp; drop, browse, or pick an example
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 2 }}>
                    <Button size="large" startIcon={<FolderOpenIcon />} onClick={() => fileInputRef.current?.click()}>
                      Browse files
                    </Button>
                    <Button
                      size="large"
                      color="secondary"
                      startIcon={<ViewInArIcon />}
                      endIcon={<ArrowDropDownIcon />}
                      onClick={(e) => setExampleAnchor(e.currentTarget)}
                    >
                      Example scenes
                    </Button>
                    <Menu anchorEl={exampleAnchor} open={Boolean(exampleAnchor)} onClose={() => setExampleAnchor(null)}>
                      {DEFAULT_EXAMPLE_SCENES.map((scene) => (
                        <MenuItem
                          key={scene.url}
                          onClick={() => {
                            setExampleAnchor(null);
                            void loadExample(scene.url, scene.title);
                          }}
                        >
                          {scene.title}
                        </MenuItem>
                      ))}
                    </Menu>
                  </Box>
                </Box>
              </Box>
            )}

            {isBusy && (
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'rgba(5,5,5,0.6)',
                  textAlign: 'center',
                }}
              >
                <Box>
                  <CircularProgress
                    variant={!progress || progress.fraction === null ? 'indeterminate' : 'determinate'}
                    value={progress && progress.fraction !== null ? progress.fraction * 100 : undefined}
                    size={64}
                    thickness={4}
                    sx={{ mb: 1.5 }}
                  />
                  <Typography variant="body1">{statusMessage}</Typography>
                  {progressText && (
                    <Typography variant="caption" color="text.secondary">
                      {progressText}
                    </Typography>
                  )}
                </Box>
              </Box>
            )}
          </Paper>

          <Box
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, mt: 1.5 }}
          >
            <Typography variant="body2" color="text.secondary">
              {statusMessage}
            </Typography>
            {(status === 'done' || status === 'error') && (
              <Button variant="text" color="secondary" startIcon={<RefreshIcon />} onClick={reset}>
                Load another
              </Button>
            )}
          </Box>

          {status === 'done' && (
            <>
            <Accordion sx={{ mt: 2 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>Navigation and collision exports</AccordionSummary>
              <AccordionDetails>
                {navSummary && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                    {navSummary}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 2 }}>
                  <Button startIcon={<DownloadIcon />} disabled={navExporting} onClick={() => void runNavmeshExport()}>
                    Export navmesh (.nav)
                  </Button>
                </Box>

                <Paper
                  variant="outlined"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 2,
                    p: 1.5,
                    mb: 2,
                    background: (theme) =>
                      `linear-gradient(120deg, ${theme.palette.success.main}14, ${theme.palette.background.paper} 42%)`,
                  }}
                >
                  {navMeshVisible ? (
                    <LayersIcon color="success" />
                  ) : (
                    <LayersClearIcon color="disabled" />
                  )}
                  <Box sx={{ flexGrow: 1, minWidth: 180 }}>
                    <Typography variant="body2" fontWeight={600}>
                      Navmesh overlay
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {navMeshVisible
                        ? 'Green walkable mesh visible — click it to move the player'
                        : 'Hidden — click-to-move still works on the walkable surface'}
                    </Typography>
                  </Box>
                  <FormControlLabel
                    control={
                      <Switch
                        color="success"
                        checked={navMeshVisible}
                        disabled={isBusy}
                        onChange={(_, checked) => {
                          setNavMeshVisibleState(checked);
                          setNavMeshVisible(checked);
                        }}
                      />
                    }
                    label={navMeshVisible ? 'Shown' : 'Hidden'}
                  />
                </Paper>

                {collisionSummary && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                    {collisionSummary}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                  <Button
                    color="secondary"
                    disabled={collisionExporting}
                    startIcon={<ViewInArIcon />}
                    onClick={() => void runCollisionGenerate()}
                  >
                    Generate collision boundary
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => {
                      const visible = !collisionBoundaryVisible;
                      setCollisionBoundaryVisibleState(visible);
                      setCollisionBoundaryVisible(visible);
                    }}
                  >
                    {collisionBoundaryVisible ? 'Hide collision boundary' : 'Show collision boundary'}
                  </Button>
                  <Button
                    variant="outlined"
                    disabled={collisionExporting}
                    startIcon={<DownloadIcon />}
                    onClick={() => void runCollisionExport()}
                  >
                    Export collision mesh (.glb)
                  </Button>
                </Box>
              </AccordionDetails>
            </Accordion>

            <Accordion sx={{ mt: 2 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>Streamed SOG export</AccordionSummary>
              <AccordionDetails>
                {sogStatusText && (
                  <Typography
                    variant="caption"
                    sx={{ display: 'block', mb: 2 }}
                    color={isLargeScene ? 'primary' : 'text.secondary'}
                  >
                    {sogStatusText}
                  </Typography>
                )}
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  color="primary"
                  value={sogMode}
                  onChange={(_, value) => value && setSogMode(value as SogExportMode)}
                  sx={{ mb: 3 }}
                >
                  <ToggleButton value="streamed">Streamed LOD</ToggleButton>
                  <ToggleButton value="single">Single SOG</ToggleButton>
                </ToggleButtonGroup>

                <Grid container spacing={2}>
                  <Grid item xs={12} sm={4}>
                    {numberField('sh_degree', 'SH Degree', {
                      min: 0,
                      max: maxShDegree,
                      step: 1,
                      helperText:
                        '0 = base color only (smaller/faster). Higher degrees keep more view-dependent color.',
                    })}
                  </Grid>
                  <Grid item xs={12} sm={4}>
                    {numberField('sh_cluster_count', 'SH Palette Size', { min: 1, max: 65536, step: 256 })}
                  </Grid>
                  <Grid item xs={12} sm={4}>
                    {numberField('sh_iterations', 'SH Iterations', { min: 1, max: 50, step: 1 })}
                  </Grid>
                  {sogMode === 'streamed' && (
                    <>
                      <Grid item xs={12} sm={4}>
                        {numberField('chunk_count', 'Splats / Chunk', { min: 1000, max: 4000000, step: 16000 })}
                      </Grid>
                      <Grid item xs={12} sm={4}>
                        {numberField('chunk_extent', 'Chunk Extent (m)', { min: 0, max: maxChunkExtent, step: 1 })}
                      </Grid>
                      <Grid item xs={12} sm={4}>
                        {numberField('lod_levels', 'LOD Levels', {
                          min: 1,
                          max: 6,
                          step: 1,
                          helperText:
                            '2+ recommended for streaming (coarse base + full detail). 1 = full detail only, no multi-LOD.',
                        })}
                      </Grid>
                    </>
                  )}
                </Grid>

                {showLodLevelsWarning && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    LOD Levels is 1 — this export is a single detail level and will not stream coarse→fine.
                  </Alert>
                )}

                <Button
                  sx={{ mt: 3 }}
                  startIcon={<DownloadIcon />}
                  disabled={sogExporting}
                  onClick={() => void runSogExport()}
                >
                  {sogExporting ? 'Exporting...' : sogExportButtonLabel}
                </Button>
              </AccordionDetails>
            </Accordion>
            </>
          )}

          {logs.length > 0 && (
            <Accordion sx={{ mt: 2 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>System logs</AccordionSummary>
              <AccordionDetails>
                <Box sx={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
                  {logs.map((entry) => (
                    <Box key={entry.id} sx={{ py: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Chip
                        size="small"
                        label={entry.tag.toUpperCase()}
                        color={tagColor[entry.tag]}
                        sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: 10 } }}
                      />
                      <span>{entry.message}</span>
                    </Box>
                  ))}
                </Box>
              </AccordionDetails>
            </Accordion>
          )}
        </Grid>
      </Grid>

      <input ref={fileInputRef} type="file" accept=".ply,.spz" style={{ display: 'none' }} onChange={onFileChange} />

      <Snackbar
        open={errorMessage !== null}
        autoHideDuration={6000}
        onClose={() => setErrorMessage(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setErrorMessage(null)} variant="filled">
          {errorMessage}
        </Alert>
      </Snackbar>
    </Container>
  );
}
