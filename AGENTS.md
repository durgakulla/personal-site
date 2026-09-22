## Project

A forkable personal-website starter built with Astro + Tailwind CSS v4 — a
static site anyone can fork and populate with their own content. It began as a
photo portfolio/grid and grew into a full personal site. Sections:

- `/` and `/albums/[album]` — photography albums (masonry grid + lightbox with EXIF)
- `/projects` — projects list, from `src/data/projects.json`
- `/about` — bio and social links, from `src/data/about.json` and `src/data/socials.json`

The content currently committed is the author's (durgakulla.com); a fork replaces
`src/data/*` and `public/images/`. Keep it generic and reusable — prefer editing
the JSON in `src/data/` and album `info.json` files over hardcoding into
templates. `src/data/about.json` `name` is the single source of truth for the
site title, sidebar wordmark, and copyright.

`npm run dev` serves the site at :4321 and mounts the content editor at
`/admin` — one server. `scripts/admin.mjs` is the editor (one file, server and
client); `scripts/admin-integration.mjs` mounts it via `astro:server:setup`, the
hook that makes it dev-only. Editing `scripts/admin.mjs` needs a dev-server
restart — it's loaded once at startup.

The editor refuses non-loopback requests and cross-origin API calls — it writes
to the repo and runs `git push`, and `astro dev --host` would otherwise expose
it. Its Publish button stages only `public/images/albums/` and `src/data/`, so
code changes never ride along with a content publish. Site and editor link to
each other's matching page, and the site live-reloads on every save.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Images

Drop full-res originals in `public/images/albums/<slug>/originals/`, then run
`npm run build` (or `node scripts/optimize-images.mjs`) to generate web-ready
copies (max 1600px on the longest edge, 85% quality, camera EXIF preserved plus
a copyright/creator stamp taken from `about.json`). `originals/` is gitignored;
`display/` is committed, `resized/` is generated on every build.

The 1600px cap is deliberate: `display/` is the largest file the site hands out,
so it's also the largest file anyone can copy. Raising it mostly benefits
whoever takes the photo.

`resized/` holds AVIF and WebP derivatives at 480/960/1440px, referenced through
`<picture>`. Their filenames carry a content hash, which is what lets
`vercel.json` serve them `immutable` for a year — a changed photo gets a new
URL. `display/` keeps stable filenames so a photo can be replaced in place, and
gets a shorter max-age with `stale-while-revalidate`. `vercel.json` is strict
JSON and cannot carry comments, hence this note.

Changing any optimizer setting rebuilds every image: cache entries record the
settings that produced them, so the first build after a change is slower.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
