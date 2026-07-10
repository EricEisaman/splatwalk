import { createApp } from 'vue';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';

import { vuetify } from '@/plugins/vuetify';
import App from '@/storage-adapter-app/App.vue';

createApp(App).use(vuetify).mount('#app');
