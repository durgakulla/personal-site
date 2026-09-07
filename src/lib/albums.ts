import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import sizeOf from 'image-size';
import exifr from 'exifr';

export type Aspect = 'landscape' | 'portrait' | 'square' | 'panorama';

export interface Photo {
  src: string;
  alt: string;
  aspect: Aspect;
  /** Intrinsic pixel size of the full image — set on <img> to reserve layout. */
  width: number;
  height: number;
  /** Responsive candidates (see scripts/optimize-images.mjs); undefined if none exist. */
  srcset?: string;
  exif?: string;
}

// Keep in sync with DERIV_WIDTHS in scripts/optimize-images.mjs.
const DERIVATIVE_WIDTHS = [480, 960, 1440];
const DISPLAY_DIR = 'display';

/** Build a srcset from whatever `resized/` derivatives exist on disk, plus the full image. */
function buildSrcset(slug: string, file: string, fullWidth: number): string | undefined {
  const resizedDir = join(ALBUMS_DIR, slug, 'resized');
  const base = file.replace(/\.[^.]+$/, '');
  const parts: string[] = [];
  for (const w of DERIVATIVE_WIDTHS) {
    if (w >= fullWidth) continue;
    const f = `${base}-${w}w.webp`;
    if (existsSync(join(resizedDir, f))) parts.push(`/images/albums/${slug}/resized/${f} ${w}w`);
  }
  if (!parts.length) return undefined;
  parts.push(`/images/albums/${slug}/${DISPLAY_DIR}/${file} ${fullWidth}w`);
  return parts.join(', ');
}

function formatExif(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const parts: string[] = [];
  if (raw.Model) {
    const model = String(raw.Model).trim();
    parts.push(model === 'ILCE-7M5' ? 'Sony A7V' : model);
  }
  if (raw.FNumber) parts.push(`f/${Number(raw.FNumber).toFixed(1)}`);
  if (raw.ExposureTime) {
    const t = Number(raw.ExposureTime);
    parts.push(t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`);
  }
  const iso = raw.ISO ?? raw.ISOSpeedRatings;
  if (iso) parts.push(`ISO ${iso}`);
  if (raw.FocalLength) parts.push(`${Math.round(Number(raw.FocalLength))}mm`);
  return parts.length ? parts.join('  ·  ') : undefined;
}

export interface AlbumMeta {
  slug: string;
  name: string;
  description?: string;
  month?: number;
  year?: number;
}

const ALBUMS_DIR = join(process.cwd(), 'public/images/albums');
const ALBUM_ORDER_FILE = join(process.cwd(), 'src/data/albums.json');
const IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;

function getAlbumOrder(): string[] {
  try { return JSON.parse(readFileSync(ALBUM_ORDER_FILE, 'utf-8')).order ?? []; }
  catch { return []; }
}

function aspectFromDims(w: number, h: number): Aspect {
  const r = w / h;
  // Slightly above 1.5 (not exactly 1.5) so a true 3:2 photo — the most common
  // camera ratio — still lands as landscape even after integer-pixel rounding
  // from resizing shifts it a hair past 1.5 (e.g. 2000/1333 = 1.50037).
  if (r > 1.52) return 'panorama';
  if (r > 1.2) return 'landscape';
  if (r < 0.85) return 'portrait';
  return 'square';
}

export function toDisplayName(slug: string): string {
  return slug
    .replace(/^\d+[-_]/, '')       // strip leading sort prefix e.g. "01-"
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function getAlbumSlugs(): string[] {
  const order = getAlbumOrder();
  return readdirSync(ALBUMS_DIR)
    .filter(name => !name.startsWith('.') && statSync(join(ALBUMS_DIR, name)).isDirectory())
    .sort()
    .sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
    });
}

export function getAlbumInfo(slug: string): { name: string; description?: string; descriptionParagraphs?: string[]; month?: number; year?: number; cover?: string; order?: string[] } {
  const infoPath = join(ALBUMS_DIR, slug, 'info.json');
  try {
    const raw = JSON.parse(readFileSync(infoPath, 'utf-8'));
    const desc = Array.isArray(raw.description) ? raw.description : raw.description ? [raw.description] : undefined;
    return {
      name: raw.name ?? toDisplayName(slug),
      description: desc?.[0],
      descriptionParagraphs: desc,
      month: raw.month !== undefined ? Number(raw.month) : undefined,
      year: raw.year !== undefined ? Number(raw.year) : undefined,
      cover: raw.cover,
      order: Array.isArray(raw.order) ? raw.order : undefined,
    };
  } catch {
    return { name: toDisplayName(slug) };
  }
}

function hasPhotos(slug: string): boolean {
  const dir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
  return existsSync(dir) && readdirSync(dir).some(f => IMAGE_RE.test(f));
}

/** Albums with at least one photo, for nav — an empty album isn't worth a dead link. */
export function getAlbumsMeta(): AlbumMeta[] {
  return getAlbumSlugs().filter(hasPhotos).map(slug => ({ slug, ...getAlbumInfo(slug) }));
}

/** Photo filenames in display order: explicit `order` entries first, then any
 *  unlisted files appended alphabetically. A newly added photo therefore never
 *  displaces an album's existing first photo (used as the fallback cover). */
function getOrderedFiles(slug: string): string[] {
  const dir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
  const allFiles = existsSync(dir) ? readdirSync(dir).filter(f => IMAGE_RE.test(f)).sort() : [];
  const { order } = getAlbumInfo(slug);
  return order?.length
    ? [...allFiles].sort((a, b) => {
        const ai = order.indexOf(a), bi = order.indexOf(b);
        return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
      })
    : allFiles;
}

export async function getPhotosForAlbum(slug: string): Promise<Photo[]> {
  const dir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
  const files = getOrderedFiles(slug);
  return Promise.all(files.map(async file => {
    const buf = readFileSync(join(dir, file));
    const { width = 1, height = 1 } = sizeOf(buf);
    const raw = await exifr.parse(buf).catch(() => undefined);
    return {
      src: `/images/albums/${slug}/${DISPLAY_DIR}/${file}`,
      alt: file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
      aspect: aspectFromDims(width, height),
      width,
      height,
      srcset: buildSrcset(slug, file, width),
      exif: formatExif(raw),
    };
  }));
}

export async function getAllPhotos(): Promise<Photo[]> {
  const all = await Promise.all(getAlbumSlugs().map(getPhotosForAlbum));
  return all.flat();
}

export function getAlbumCover(slug: string): Photo | null {
  const dir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
  const { cover: coverFile } = getAlbumInfo(slug);
  const file = coverFile && IMAGE_RE.test(coverFile)
    ? coverFile
    : getOrderedFiles(slug)[0];
  if (!file) return null;
  const { width = 1, height = 1 } = sizeOf(readFileSync(join(dir, file)));
  return {
    src: `/images/albums/${slug}/${DISPLAY_DIR}/${file}`,
    alt: toDisplayName(slug),
    aspect: aspectFromDims(width, height),
    width,
    height,
    srcset: buildSrcset(slug, file, width),
  };
}
