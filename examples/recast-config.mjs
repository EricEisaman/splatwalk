// Convert SplatWalk's reference agent dimensions (metres) into Recast's integer
// voxel counts. Skipping this conversion silently truncates sub-metre climb /
// radius to 0 voxels, producing a slab or a fragmented navmesh.
//
//   npm install @splatwalk/core
//   node recast-config.mjs
//
// @splatwalk/core is MIT-licensed and free forever (see ../LICENSING.md).

import init, {
  init_splatwalk,
  recast_agent_defaults,
  recast_config,
} from '@splatwalk/core';

await init();
init_splatwalk();

const agent = recast_agent_defaults();
console.log('Reference agent (metres):', agent);

// Pass the highest floor-cell Y (metres) to also get suggested vertical headroom.
const highestFloorY = 2.4;

const cfg = recast_config({ ...agent, maxFloorY: highestFloorY });

console.log('Recast config (voxel counts + padding):');
console.log(`  walkableHeight = ${cfg.walkableHeight} voxels`);
console.log(`  walkableClimb  = ${cfg.walkableClimb} voxels`);
console.log(`  walkableRadius = ${cfg.walkableRadius} voxels`);
console.log(`  bmaxYPadding   = ${cfg.bmaxYPadding} m`);
console.log(`  suggestedBmaxY = ${cfg.suggestedBmaxY} m`);

// Feed cfg.* straight into your rcConfig; set bmax[1] = cfg.suggestedBmaxY.
