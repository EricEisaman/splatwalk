import type { ExampleCollisionSceneType } from '@/navigation/exampleSceneCollision';

/** A selectable example splat scene shown in the "Example scenes" menu. */
export interface ExampleScene {
  readonly collisionSceneType: ExampleCollisionSceneType;
  readonly title: string;
  readonly url: string;
}

/**
 * Built-in example scenes, kept in sync with the Vuetify showcase
 * (`src/components/vuetify/SplatFastNavShowcase.vue`).
 */
export const DEFAULT_EXAMPLE_SCENES: readonly ExampleScene[] = [
  {
    collisionSceneType: 'indoor',
    title: 'Bedroom',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'PurplePad',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/PurplePad.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Bridge',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/Bridge.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Meadow',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/meadow.spz',
  },
  {
    collisionSceneType: 'outdoor',
    title: 'Tropical Compound',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'Industrial Warehouse',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply',
  },
  {
    collisionSceneType: 'indoor',
    title: 'Stairs',
    url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/stairs.spz',
  },
];
