import type { APIRoute } from 'astro';

// Generated rather than dropped in public/ so the sitemap URL follows `site` in
// astro.config.mjs — a fork changes the domain in one place, not two.
export const GET: APIRoute = ({ site }) =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap-index.xml', site)}\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
