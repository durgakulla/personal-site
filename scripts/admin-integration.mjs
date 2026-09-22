import { createAdminHandler } from './admin.mjs';

/**
 * Mounts the content editor into `astro dev`, so a fork runs one command and
 * finds it at /admin — no second server, no second port, and the site it edits
 * is the same origin it's served from.
 *
 * Dev-only by construction rather than by a flag: `astro:server:setup` is the
 * only hook here, and Astro fires it just after the Vite dev server is created.
 * A build never creates one, and `astro preview` configures its own server
 * through a different hook — so there is no path by which this reaches the
 * deployed site.
 */
export default function adminPanel({ base = '/admin' } = {}) {
  return {
    name: 'admin-panel',
    hooks: {
      'astro:server:setup': ({ server, logger }) => {
        // Connect strips this prefix before the handler sees the request, which
        // is why the handler's routes are written as though it were mounted at
        // the root — the standalone server mounts it exactly that way.
        server.middlewares.use(base, createAdminHandler({ base }));
        logger.info(`Content editor → ${base}`);
      },
    },
  };
}
