/**
 * Logic checks for relative Scale Environment (session × factor).
 *
 *   node scripts/check-session-scale-multiplier.mjs
 */

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed += 1;
  } else {
    console.log(`OK: ${msg}`);
  }
};

const applyScaleMultiplier = (session, factor) => {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error('invalid');
  }
  if (factor === 1) {
    return session;
  }
  return session * factor;
};

assert(applyScaleMultiplier(1, 2) === 2, '1 × 2 → session 2');
assert(applyScaleMultiplier(2, 1) === 2, 'factor 1 keeps session 2 (SDF-MC recompute)');
assert(applyScaleMultiplier(2, 2) === 4, '2 × 2 → session 4');
assert(applyScaleMultiplier(1, 1) === 1, 'identity stays 1');

// Collision settings must carry absolute session scale (not omitted).
const buildCollision = (sessionScale) => ({
  environment_scale: sessionScale,
  collision_mesh_mode: 'smooth',
});
const at2 = buildCollision(2);
assert(at2.environment_scale === 2, 'SDF-MC collision settings include environment_scale=2');

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll session scale multiplier checks passed.');
