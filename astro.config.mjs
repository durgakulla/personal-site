// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://durgakulla.com',
  devToolbar: { enabled: false },
  // Almost every interaction here is clicking from the album index into an
  // album, and those pages are only 4-6KB over the wire — so fetch them on
  // hover and the click lands on an already-loaded page.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()]
  }
});
