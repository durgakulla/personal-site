import sharp from 'sharp';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ALBUMS_DIR = 'public/images/albums';
const CACHE_FILE = 'public/images/albums/.optimize-cache.json';
const MAX_DIMENSION = 2000; // longest edge, either orientation
const QUALITY     = 85;
const IMAGE_RE    = /\.(jpg|jpeg|png|webp)$/i;

// Responsive derivatives generated in a `resized/` subfolder alongside
// `display/`, and referenced via srcset. Keep DERIV_WIDTHS in sync with
// src/lib/albums.ts. The full-size image in `display/` stays the largest
// srcset candidate.
const DERIV_WIDTHS   = [480, 960, 1440];
const DISPLAY_DIR    = 'display';
const DERIV_DIR      = 'resized';
const DERIV_QUALITY  = 80;

let cache = {};
try { cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch {}

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

    if (cache[key]?.mtime === mtimeMs && existsSync(outPath)) {
      skipped++;
      continue;
    }

    const ext = file.split('.').pop().toLowerCase();
    let pipeline = sharp(srcPath)
      .withMetadata()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });

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

    cache[key] = { mtime: mtimeMs };
    console.log(`  ✓ ${key}  ${(size / 1e6).toFixed(1)}MB → ${(buf.length / 1e6).toFixed(1)}MB  (-${reduction}%)`);
    processed++;
  }
}

// ── Responsive derivatives ───────────────────────────────────────────────────
// Runs for every album, over the display/ images, so albums whose images were
// placed directly in display/ (bypassing originals/) are covered too.
let derivMade = 0, derivFresh = 0;

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

    if (cache[key]?.mtime === mtimeMs && outPaths.every(existsSync)) {
      derivFresh++;
      continue;
    }

    if (targets.length && !existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    for (const w of targets) {
      const buf = await sharp(srcPath)
        .rotate()                                   // bake in EXIF orientation
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: DERIV_QUALITY })
        .toBuffer();
      writeFileSync(join(outDir, `${base}-${w}w.webp`), buf);
    }

    cache[key] = { mtime: mtimeMs };
    if (targets.length) derivMade++;
  }
}

writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log(`\nImages: ${processed} optimized, ${skipped} skipped, ${(saved / 1e6).toFixed(1)}MB saved`);
console.log(`Derivatives: ${derivMade} rebuilt, ${derivFresh} up-to-date`);
