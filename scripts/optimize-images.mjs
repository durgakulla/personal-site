import sharp from 'sharp';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const ALBUMS_DIR = 'public/images/albums';
const CACHE_FILE = 'public/images/albums/.optimize-cache.json';
// Longest edge, either orientation. Deliberately smaller than print-usable:
// this is the largest file the site hands out, so it's also the largest file
// anyone can take. 1600px stays sharp fit-to-screen on any display while being
// a ~5in print at 300dpi. Raising it mostly benefits whoever copies the photo.
const MAX_DIMENSION = 1600;
const QUALITY     = 85;
const IMAGE_RE    = /\.(jpg|jpeg|png|webp)$/i;

// Stamped into every file this script writes, so ownership travels with the
// image once it leaves the site. Sourced from about.json so a fork gets its
// own name without editing this script.
const about   = JSON.parse(readFileSync('src/data/about.json', 'utf-8'));
const CREATOR = about.copyright ?? about.name ?? '';
const EXIF_STAMP = CREATOR
  ? { IFD0: { Copyright: `\u00a9 ${CREATOR}`, Artist: CREATOR } }
  : null;

// Responsive derivatives generated in a `resized/` subfolder alongside
// `display/`, and referenced via srcset. Keep DERIV_WIDTHS in sync with
// src/lib/albums.ts. The full-size image in `display/` stays the largest
// srcset candidate.
const DERIV_WIDTHS   = [480, 960, 1440];
const DISPLAY_DIR    = 'display';
const DERIV_DIR      = 'resized';
const DERIV_QUALITY  = 80;

// The cache keys on the source file's mtime, so changing a setting below would
// otherwise leave every already-rendered file untouched. Fold the settings that
// affect output into the entry and rebuild when they differ.
const RENDER_KEY = JSON.stringify({
  MAX_DIMENSION, QUALITY, DERIV_WIDTHS, DERIV_QUALITY, stamp: CREATOR,
});

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {}

function isFresh(key, mtimeMs) {
  return cache[key]?.mtime === mtimeMs && cache[key]?.render === RENDER_KEY;
}

let processed = 0, skipped = 0, saved = 0;

const slugs = readdirSync(ALBUMS_DIR).filter(n =>
  !n.startsWith('.') && statSync(join(ALBUMS_DIR, n)).isDirectory()
);

for (const slug of slugs) {
  const originalsDir = join(ALBUMS_DIR, slug, 'originals');
  if (!existsSync(originalsDir)) continue;

  const files = readdirSync(originalsDir).filter(f => IMAGE_RE.test(f));

  const displayDir = join(ALBUMS_DIR, slug, DISPLAY_DIR);

  for (const file of files) {
    const srcPath = join(originalsDir, file);
    const outPath = join(displayDir, file);
    const key     = `${slug}/${file}`;
    const { mtimeMs, size } = statSync(srcPath);

    if (isFresh(key, mtimeMs) && existsSync(outPath)) {
      skipped++;
      continue;
    }

    const ext = file.split('.').pop().toLowerCase();
    let pipeline = sharp(srcPath)
      .keepMetadata()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });

    // Merge, so the camera's own EXIF survives and only the ownership fields
    // are set (or replaced, for files that arrive with someone else's).
    if (EXIF_STAMP) pipeline = pipeline.withExifMerge(EXIF_STAMP);

    if (ext === 'png') {
      pipeline = pipeline.png({ quality: QUALITY });
    } else if (ext === 'webp') {
      pipeline = pipeline.webp({ quality: QUALITY });
    } else {
      pipeline = pipeline.jpeg({ quality: QUALITY, mozjpeg: true });
    }

    const buf = await pipeline.toBuffer();
    const reduction = Math.round((1 - buf.length / size) * 100);
    saved += size - buf.length;
    if (!existsSync(displayDir)) mkdirSync(displayDir, { recursive: true });
    writeFileSync(outPath, buf);

    cache[key] = { mtime: mtimeMs, render: RENDER_KEY };
    console.log(`  ✓ ${key}  ${(size / 1e6).toFixed(1)}MB → ${(buf.length / 1e6).toFixed(1)}MB  (-${reduction}%)`);
    processed++;
  }
}

// ── Responsive derivatives ───────────────────────────────────────────────────
// Runs for every album, over the display/ images, so albums whose images were
// placed directly in display/ (bypassing originals/) are covered too.
let derivMade = 0, derivFresh = 0, derivPruned = 0;

for (const slug of slugs) {
  const albumDir   = join(ALBUMS_DIR, slug);
  const displayDir = join(albumDir, DISPLAY_DIR);
  const outDir     = join(albumDir, DERIV_DIR);
  if (!existsSync(displayDir)) continue;
  const files = readdirSync(displayDir).filter(f =>
    IMAGE_RE.test(f) && statSync(join(displayDir, f)).isFile()
  );

  for (const file of files) {
    const srcPath   = join(displayDir, file);
    const { mtimeMs } = statSync(srcPath);
    const base      = file.replace(/\.[^.]+$/, '');
    const key       = `resized/${slug}/${file}`;

    const meta    = await sharp(srcPath).metadata();
    const srcW    = meta.width ?? 0;
    const targets = DERIV_WIDTHS.filter(w => w < srcW);
    const outPaths = targets.map(w => join(outDir, `${base}-${w}w.webp`));

    if (isFresh(key, mtimeMs) && outPaths.every(existsSync)) {
      derivFresh++;
      continue;
    }

    if (targets.length && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    for (const w of targets) {
      // Resize to raw pixels first. Encoding straight from the display JPEG
      // drags its ~11KB embedded thumbnail into every derivative — 40% of a
      // 480w file — and withExif replaces IFD0 without dropping it. Raw carries
      // no metadata at all, so the re-encode writes exactly the stamp: same
      // pixels, 250 bytes of EXIF instead of 11,600. Still a single webp encode,
      // so there's no generational quality loss.
      const { data, info } = await sharp(srcPath)
        .rotate()                                   // bake in EXIF orientation
        .resize({ width: w, withoutEnlargement: true })
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });

      let pipeline = sharp(data, {
        raw: { width: info.width, height: info.height, channels: info.channels },
      });
      // These are what most visitors actually receive, and they used to ship
      // with no metadata at all — so ownership travelled with nothing.
      if (EXIF_STAMP) pipeline = pipeline.withExif(EXIF_STAMP);

      const buf = await pipeline.webp({ quality: DERIV_QUALITY }).toBuffer();
      writeFileSync(join(outDir, `${base}-${w}w.webp`), buf);
    }

    cache[key] = { mtime: mtimeMs, render: RENDER_KEY };
    if (targets.length) derivMade++;
  }

  // Drop derivatives that no longer correspond to a display image at a width we
  // still generate. Lowering MAX_DIMENSION leaves the previous run's larger
  // files sitting in resized/, where they stay reachable by URL — so a photo
  // capped at 1200px would still be downloadable at 1440px, quietly undoing the
  // cap. buildSrcset() won't reference them, which is exactly why they'd go
  // unnoticed.
  if (existsSync(outDir)) {
    const wanted = new Set();
    for (const file of files) {
      const base   = file.replace(/\.[^.]+$/, '');
      const srcW   = (await sharp(join(displayDir, file)).metadata()).width ?? 0;
      for (const w of DERIV_WIDTHS.filter(w => w < srcW)) wanted.add(`${base}-${w}w.webp`);
    }
    for (const f of readdirSync(outDir)) {
      if (!/-\d+w\.webp$/.test(f) || wanted.has(f)) continue;
      unlinkSync(join(outDir, f));
      delete cache[`resized/${slug}/${f}`];
      derivPruned++;
      console.log(`  ✗ pruned stale derivative ${slug}/${f}`);
    }
  }
}

writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log(`\nImages: ${processed} optimized, ${skipped} skipped, ${(saved / 1e6).toFixed(1)}MB saved`);
console.log(`Derivatives: ${derivMade} rebuilt, ${derivFresh} up-to-date, ${derivPruned} pruned`);
