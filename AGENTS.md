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

`npm run admin` starts a local-only editor (http://localhost:4001) for album
metadata, About, and Projects.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Images

Drop full-res originals in `public/images/albums/<slug>/originals/`, then run
`npm run build` (or `node scripts/optimize-images.mjs`) to generate web-ready
copies (max 2000px on the longest edge, 85% quality, EXIF preserved). `originals/` is gitignored;
optimized files are committed.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
