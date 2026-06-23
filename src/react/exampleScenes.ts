/** A selectable example splat scene shown in the "Example scenes" menu. */
export interface ExampleScene {
  readonly title: string;
  readonly url: string;
}

/**
 * Built-in example scenes, kept in sync with the Vuetify showcase
 * (`src/components/vuetify/SplatFastNavShowcase.vue`).
 */
export const DEFAULT_EXAMPLE_SCENES: readonly ExampleScene[] = [
  { title: 'Bedroom', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/bedroom.ply' },
  { title: 'Tropical Compound', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/tropical_compound.ply' },
  { title: 'Industrial Warehouse', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/industrial_warehouse.ply' },
  { title: 'Stairs', url: 'https://raw.githubusercontent.com/EricEisaman/assets/main/environment/splats/stairs.spz' },
];
