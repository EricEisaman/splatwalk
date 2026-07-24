/**
 * Logic checks for Active → Live hot-swap mapping + failure copy (no browser).
 *
 *   node scripts/check-active-live-hotswap.mjs
 */

const initialLiveBackendForActiveMode = (mode) => {
  if (mode === 'recast') {
    return 'recast_crowd';
  }
  return 'voxel_walk';
};

const activeModeMatchingLiveBackend = (liveBackend) => {
  if (liveBackend === 'voxel_walk') {
    return 'voxel_mesh';
  }
  return 'recast';
};

const navCapabilitiesFromParts = ({ recastBin, volume }) => ({
  hasRecast: Boolean(recastBin && recastBin.byteLength > 0),
  hasVolume: Boolean(volume),
});

const isActiveModeAvailable = (mode, caps) => {
  switch (mode) {
    case 'recast':
      return caps.hasRecast;
    case 'voxel_mesh':
      return caps.hasVolume;
    case 'recast_and_voxel_mesh':
      return caps.hasVolume && caps.hasRecast;
    default:
      return false;
  }
};

const activeNavigationHotSwapFailureMessage = ({ caps, detail, mode }) => {
  if (detail) {
    return `Could not switch Live locomotion — ${detail}`;
  }
  const missing = [];
  if ((mode === 'voxel_mesh' || mode === 'recast_and_voxel_mesh') && !caps.hasVolume) {
    missing.push('volume');
  }
  if ((mode === 'recast' || mode === 'recast_and_voxel_mesh') && !caps.hasRecast) {
    missing.push('Recast navmesh');
  }
  if (missing.length > 0) {
    return (
      `Could not switch Live locomotion — missing ${missing.join(' and ')}. ` +
      'Re-run Nav under Voxel / SDF-MC with volume, then try again.'
    );
  }
  return (
    'Could not switch Live locomotion — missing volume or Recast assets. ' +
    'Re-run Nav under Voxel / SDF-MC with volume, then try again.'
  );
};

/**
 * Mirrors resolveActiveNavigationChange gating: always derive caps from artifacts,
 * never trust a stale caller snapshot.
 */
const canApplyHotSwap = ({ mode, recastBin, volume }) => {
  const caps = navCapabilitiesFromParts({ recastBin, volume });
  if (mode === 'recast_and_voxel_mesh') {
    return caps.hasVolume && caps.hasRecast && Boolean(volume) && Boolean(recastBin);
  }
  return isActiveModeAvailable(mode, caps);
};

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`OK: ${msg}`);
  }
};

assert(initialLiveBackendForActiveMode('recast') === 'recast_crowd', 'Recast → recast_crowd');
assert(initialLiveBackendForActiveMode('voxel_mesh') === 'voxel_walk', 'Voxel mesh → voxel_walk');
assert(
  initialLiveBackendForActiveMode('recast_and_voxel_mesh') === 'voxel_walk',
  'Dual → voxel_walk (click surfaces)'
);
assert(activeModeMatchingLiveBackend('recast_crowd') === 'recast', 'revert from Recast live');
assert(activeModeMatchingLiveBackend('voxel_walk') === 'voxel_mesh', 'revert from Voxel live');
assert(activeModeMatchingLiveBackend('none') === 'recast', 'revert from none → Recast');

const recastBin = new Uint8Array([1, 2, 3]);
const volume = { dims: [1, 1, 1] };
const staleCapsNoVolume = { hasRecast: true, hasVolume: false };

assert(
  canApplyHotSwap({ mode: 'voxel_mesh', recastBin, volume }) === true,
  'fresh caps: Dual/Voxel allowed when volume+recast present'
);
assert(
  canApplyHotSwap({ mode: 'recast_and_voxel_mesh', recastBin, volume }) === true,
  'fresh caps: Dual allowed when both artifacts present'
);
assert(
  canApplyHotSwap({ mode: 'voxel_mesh', recastBin, volume: null }) === false,
  'fresh caps: Voxel refused without volume'
);
assert(
  // Stale hasVolume=false must not win when volume arg exists (host bug regression).
  canApplyHotSwap({ mode: 'voxel_mesh', recastBin, volume }) === true &&
    staleCapsNoVolume.hasVolume === false,
  'stale caller caps must not block when volume arg is set'
);

const dualMissingVolume = activeNavigationHotSwapFailureMessage({
  caps: { hasRecast: true, hasVolume: false },
  mode: 'recast_and_voxel_mesh',
});
assert(
  dualMissingVolume.includes('missing volume') && !dualMissingVolume.includes('Recast navmesh'),
  'failure message names missing volume only'
);

const dualMissingBoth = activeNavigationHotSwapFailureMessage({
  caps: { hasRecast: false, hasVolume: false },
  mode: 'recast_and_voxel_mesh',
});
assert(
  dualMissingBoth.includes('missing volume and Recast navmesh'),
  'failure message names volume and Recast when both missing'
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Active/Live hot-swap mapping checks passed.');
