# Personal Site Starter

A fast, forkable personal website built with [Astro](https://astro.build) and
[Tailwind CSS v4](https://tailwindcss.com) — photo albums with a masonry grid
and lightbox, a projects list, and an about page. It ships with a full local
admin panel for editing everything (albums, photos, cover selection, ordering,
your name/bio/tagline, projects) without touching code or the filesystem by hand.

**Demo:** [durgakulla.com](https://durgakulla.com)

> The photos and text committed here are mine, so a fork starts as a copy of my
> site. [Getting Started](#getting-started) walks through replacing them — the
> admin panel does the whole job, no files to edit by hand. Please do swap the
> photographs out rather than publishing them as part of your own site.

## Features

- Masonry photo grid with lightbox and EXIF display (camera, aperture, shutter, ISO, focal length)
- **Full local admin panel** — add/reorder/delete albums and photos, set covers, edit your name/bio/projects, drag-and-drop uploads, all with autosave
- Build-time image pipeline (Sharp) — drop full-res originals in, get web-optimized, EXIF-preserving copies out, at multiple responsive sizes
- Dark / light mode, auto-generated sitemap, Open Graph tags, Person JSON-LD
- Fully static — deploys to the Vercel free tier

## Sections

| Route | Source | What it is |
|---|---|---|
| `/` | `public/images/albums/*` | Album index — masonry grid of album covers |
| `/albums/[album]` | `public/images/albums/<slug>/` | A single album: masonry photo grid + lightbox with EXIF |
| `/projects` | `src/data/projects.json` | Things you've built |
| `/about` | `src/data/about.json` + `src/data/socials.json` | Bio, gear, social links |

## Getting Started

Requires Node 22.12+.

**1. Fork this repo.** Use the Fork button on GitHub, so you get a copy you can
push to — that's what the admin panel's Publish button pushes to later. Your
fork arrives with the demo content (my photos, my bio); step 4 replaces it.

**2. Clone your fork and start it.**

```bash
git clone https://github.com/<you>/<your-fork>.git
cd <your-fork>
npm install
npm run dev        # → http://localhost:4321
```

That one command gives you both the site and the admin panel for editing its
content:

| | |
|---|---|
| `http://localhost:4321` | the site |
| `http://localhost:4321/admin` | the editor |

**3. Set your domain** in `astro.config.mjs`. It's what the sitemap, canonical
URLs and Open Graph tags are built from — not routing, so the site runs fine
until you have one.

```js
site: 'https://yourdomain.com',
```

**4. Replace the demo content.** All of it is editable at
`localhost:4321/admin`, and none of it needs a text editor:

| In the editor | What it replaces |
|---|---|
| **Home** | the site name and homepage tagline — your name is the wordmark, the page title and the copyright line |
| **About** | heading, bio paragraphs, gear list, and the social links |
| **Projects** | the projects list |
| **Albums** | Delete Album on each of mine, then **+ New Album** and drag your photos straight in |

Every page handles being empty, so you can clear the albums out before you have
your own photos ready and the site still builds and looks intentional.

When you like what you see, the editor's **Publish** button commits and pushes
it to your fork — see [Publishing from the admin panel](#publishing-from-the-admin-panel).

### What you're running

The site and the editor each carry a small pill in the bottom-left corner
pointing at the other's matching page — editing an album and clicking through
lands you on that album on the site, and back again. The site reloads by itself
whenever you save something in the editor.

Both are dev-only. The editor is mounted by an Astro integration that registers
a dev-server hook and nothing else, so it cannot reach a build — and the pill is
compiled out of the deployed site entirely.

It also refuses any request that doesn't come from your own machine, so
`astro dev --host` (which serves the site to your network) never exposes an API
that writes to your repo. Viewed from another device that way, the site works
normally and the editor simply isn't offered.

## Using the Admin Panel

The admin panel (`/admin` while `npm run dev` is running) is a small local Node
server — no build step, no login, writes straight to the files on disk. It's one
file, `scripts/admin.mjs`, mounted into the dev server by
`scripts/admin-integration.mjs`. Everything **autosaves**
a moment after you stop typing (or immediately for drag-and-drop actions), so
there's rarely a "Save" button you actually need — though one's always there
if you want to force it.

### Home

The default view. Edit your site name and homepage tagline (both live in
`src/data/about.json`). Click the "Site Admin" logo any time to get back here.

### About / Projects

Page heading, bio paragraphs, and gear list (About); a reorderable, add/removable
list of `{ name, description, href }` cards (Projects). Same drag-to-reorder,
autosave-everything behavior as albums.

### Albums

Each album gets its own editor:

- **Name, date, description** — plain fields, autosave.
- **Add photos** — drag image files from Finder anywhere onto the album page.
  They're saved to `originals/`, then automatically optimized; the new photos
  appear in the order strip and are appended to the album order — no manual
  build step needed.
- **Reorder** — drag thumbnails in the order strip; a drop-line shows exactly
  where the photo will land.
- **Set cover** — double-click a thumbnail. If you never set one, the first
  photo in the album stands in as the cover automatically (on both the admin
  preview and the live site).
- **Delete a photo** — hover a thumbnail, click the × that appears, confirm.
  This permanently removes it (display copy, original, and derivatives) — make
  sure you have the original saved elsewhere first.
- **Delete an album** — the red "Delete Album" button, with a confirmation
  dialog spelling out exactly what gets removed.
- **Preview** — a live masonry preview matches the real site's layout logic
  (panorama breakouts, column balancing), plus a floating mini-preview on wide
  screens so you don't have to scroll to see the whole album while editing.
- **Reorder albums themselves** — drag album chips in the sidebar; this
  controls the order they appear on the homepage and in the nav.
- **+ New Album** — prompts for a folder name and creates it, ready to drop
  photos into.

## How Images Work

Each album folder looks like this once you've added photos:

```
public/images/albums/your-album/
  info.json         # name, date, description, cover, photo order
  originals/         # your full-res source files — gitignored, never touched again
  display/            # optimized 1600px-longest-edge copies — what the site actually serves
  resized/             # AVIF + WebP derivatives (480w/960w/1440w) for responsive srcset
```

Drop full-res files into `originals/`, then run:

```bash
npm run build                        # runs the optimizer, then astro build
# or, without a full build:
node scripts/optimize-images.mjs
```

(The admin panel does this automatically after every drag-and-drop upload —
you never need to run it by hand while using the admin panel.)

For each photo, this generates:
- A **display copy** in `display/` — longest edge capped at 1600px (whichever
  dimension that is, so portraits and landscapes get equivalent treatment),
  85% quality, camera EXIF preserved plus a copyright/creator stamp taken from
  your `about.json`. This is the largest image the site ever serves, which is
  also the largest anyone can copy from it — the cap is deliberate.
- **Responsive derivatives** in `resized/`, at 480w/960w/1440w in both AVIF and
  WebP, offered through a `<picture>` element so the browser takes the best
  format it can decode at the smallest size that still looks sharp. Their
  filenames carry a content hash, which is what lets `vercel.json` cache them
  for a year: change a photo and it gets a new URL.

The optimizer is incremental — it caches by source file modification time
(`public/images/albums/.optimize-cache.json`), so re-running it only
reprocesses photos that actually changed. The cache also records the settings
that produced each file, so changing any of them (the size cap, a quality, the
formats, or the name stamped into the EXIF) correctly rebuilds every image —
expect the first build after such a change to be slow.

Albums are ordered via `src/data/albums.json` (edit through the admin
sidebar's drag-and-drop, not by hand); within an album, `info.json`'s `order`
array controls photo order, again normally set by dragging in the admin panel.

## Making It Your Own

Prefer editing with the admin panel over touching these directly, but everything
is plain JSON if you'd rather:

| File | What it holds |
|---|---|
| `src/data/about.json` | Site name, homepage tagline, About page heading/bio/gear |
| `src/data/socials.json` | Social links (Instagram, LinkedIn, GitHub, Email) |
| `src/data/projects.json` | Projects list |
| `src/data/albums.json` | Album display order |
| `public/images/albums/<slug>/info.json` | Per-album name, date, description, cover, photo order |

## Deployment

Connect your fork to [Vercel](https://vercel.com) — it picks up the build
command (`node scripts/optimize-images.mjs && astro build`) automatically from
`package.json`. Every push to `main` then rebuilds the site, including the ones
the Publish button makes.

The site is fully static, so nothing in `scripts/` runs in production — the
admin panel exists only while `npm run dev` is running on your own machine.

Don't forget `site:` in `astro.config.mjs` (step 3 above) — without it the
sitemap and Open Graph tags point at the wrong domain.

### Publishing from the admin panel

The admin panel's **Publish** button commits and pushes your content, and
Vercel rebuilds from there. It runs against whatever git is configured in
your clone, so in a fork it pushes to *your* repo — there is no account or
token to set up, and nothing is sent anywhere else.

It stages only the paths the panel itself writes — `public/images/albums/`
and `src/data/` — so a code change in your working tree is never swept into
a content publish. Use git directly for those.

Before the first publish, a fresh clone needs the two things any commit
needs; the panel says so rather than failing halfway:

```bash
git config user.name "Your Name"
git config user.email you@example.com
```

Your clone also needs a remote you can write to. A fork you cloned yourself
already has one. A clone of *someone else's* repo points at theirs, and the
push will be rejected — the panel names the destination before you press
anything, so check it reads as your own repo. To repoint it:

```bash
git remote set-url origin https://github.com/you/your-site.git
```

On a branch that has never been pushed, the first publish sets the upstream
for you. If you'd rather not publish from the browser at all, ignore the
button: committing and pushing by hand works exactly as it always did.

## Stack

- [Astro](https://astro.build) — static site generation
- [Tailwind CSS v4](https://tailwindcss.com) — styling
- [Sharp](https://sharp.pixelplumbing.com) — build-time image optimization
- [exifr](https://github.com/MikeKovarik/exifr) — EXIF extraction
- A small vanilla Node HTTP server (`scripts/admin.mjs`) — the admin panel, no framework, no build step; mounted into the dev server as middleware by `scripts/admin-integration.mjs`

### Notes for forks

- `/admin` is served by middleware, so a page at `src/pages/admin.astro` would be
  shadowed by it. Pass a different mount point if you want that URL:
  `adminPanel({ base: '/editor' })` in `astro.config.mjs`.
- The editor's routes are plain paths under that mount. Setting Astro's
  `trailingSlash: 'always'` breaks them; `'ignore'` (the default) and `'never'`
  are both fine.
