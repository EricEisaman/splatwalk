<script setup lang="ts">
import SplatFastNavShowcase from '@/components/vuetify/SplatFastNavShowcase.vue';
</script>

<template>
  <v-app>
    <v-app-bar flat color="surface" border>
      <v-app-bar-title class="text-primary font-weight-black text-uppercase">
        SplatWalk
        <span class="text-secondary">/ FastNav</span>
      </v-app-bar-title>

      <template #append>
        <v-btn href="/" prepend-icon="mdi-home" variant="text" color="primary">
          Home
        </v-btn>
        <v-btn
          href="https://github.com/EricEisaman/splatwalk"
          target="_blank"
          rel="noopener noreferrer"
          prepend-icon="mdi-github"
          variant="text"
          color="secondary"
        >
          GitHub
        </v-btn>
      </template>
    </v-app-bar>

    <v-main>
      <SplatFastNavShowcase />
    </v-main>
  </v-app>
</template>
