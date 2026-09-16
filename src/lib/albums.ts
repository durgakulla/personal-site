import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import sizeOf from 'image-size';
import exifr from 'exifr';
// Aspect thresholds, the display-name fallback and the cover rule are shared
// with the client-side grid and the admin preview — see src/lib/layout.mjs.
import { aspectFromDims, toDisplayName, effectiveCover } from './layout.mjs';

export { toDisplayName };

export type Aspect = 'landscape' | 'portrait' | 'square' | 'panorama';

/** One <source> in a <picture>: every derivative of a single format. */
export interface ImageSource {
  /** MIME type, best-first — the browser takes the first it can decode. */
  type: string;
  srcset: string;
}

export interface Photo {
  src: string;
  alt: string;
  aspect: Aspect;
  /** Intrinsic pixel size of the full image — set on <img> to reserve layout. */
  width: number;
  height: number;
  /** AVIF then WebP candidates (see scripts/optimize-images.mjs); empty if none exist. */
  sources: ImageSource[];
  exif?: string;
}

const DISPLAY_DIR = 'display';
const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp' };

// Derivative filenames are <base>-<width>w-<hash>.<ext>. Matched from the right,
// because a base name can itself contain dashes ("R0001997-edit1").
const DERIVATIVE_RE = /^(.*)-(\d+)w-[0-9a-f]{8}\.(avif|webp)$/;

// One readdir per album instead of an existsSync per candidate file.
const resizedDirCache = new Map<string, string[]>();
function listResized(slug: string): string[] {
  let files = resizedDirCache.get(slug);
  if (!files) {
    const dir = join(ALBUMS_DIR, slug, 'resized');
    files = existsSync(dir) ? readdirSync(dir) : [];
    resizedDirCache.set(slug, files);
  }
  return files;
}

/**
 * Collect the derivatives on disk for one photo, grouped into a <source> per
 * format. The optimizer hashes the filenames so they can be cached forever,
 * which means they can't be predicted from the base name — they're discovered.
 */
function buildSources(slug: string, file: string): ImageSource[] {
  const base = file.replace(/\.[^.]+$/, '');
  const byExt = new Map<string, string[]>();

  for (const f of listResized(slug)) {
    const m = DERIVATIVE_RE.exec(f);
    if (!m || m[1] !== base) continue;
    const [, , width, ext] = m;
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext)!.push(`/images/albums/${slug}/resized/${f} ${width}w`);
  }

  // Order by the format list, not by whatever order readdir returned.
  return Object.keys(MIME)
    .filter(ext => byExt.has(ext))
    .map(ext => ({ type: MIME[ext], srcset: byExt.get(ext)!.sort(byWidth).join(', ') }));
}

function byWidth(a: string, b: string): number {
  return parseInt(a.split(' ').pop()!, 10) - parseInt(b.split(' ').pop()!, 10);
}

// Model codes no one would recognise, by the name the camera is sold under.
// Complete names — the brand isn't prefixed to these.
const CAMERA_MODELS: Record<string, string> = { 'ILCE-7M5': 'Sony A7V' };

// EXIF Make is a shouty manufacturer string ("FUJIFILM", "RICOH IMAGING
// COMPANY, LTD."), so the brand is taken from its first word. Title-casing that
// gets most of them right; these are the exceptions. An empty string means the
// model already names itself ("iPhone 16 Pro") and wants no brand in front.
const CAMERA_MAKES: Record<string, string> = { APPLE: '', DJI: 'DJI', GOPRO: 'GoPro' };

/**
 * "Fujifilm X-T3" from Make "FUJIFILM" and Model "X-T3" — a bare body code
 * doesn't say what it came off. Models that already lead with the brand are
 * re-cased rather than repeated, so "RICOH GR IV" reads "Ricoh GR IV".
 */
function cameraName(make: unknown, model: unknown): string {
  const name = String(model).trim();
  if (CAMERA_MODELS[name]) return CAMERA_MODELS[name];

  const word = String(make ?? '').trim().split(/[\s,]+/)[0] ?? '';
  if (!word) return name;
  const brand = CAMERA_MAKES[word.toUpperCase()]
    ?? word[0].toUpperCase() + word.slice(1).toLowerCase();

  const rest = name.toLowerCase().startsWith(word.toLowerCase())
    ? name.slice(word.length).trim()
    : name;
  return `${brand} ${rest}`.trim();
}

function formatExif(raw: Record<string, unknown> | undefined): string | undefined {
  if (!raw) return undefined;
  const parts: string[] = [];
  if (raw.Model) parts.push(cameraName(raw.Make, raw.Model));
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
      // Decorative: in a photo gallery the image *is* the content, and a
      // filename ("R0001997 edit1") is noise for a screen reader. An empty alt
      // lets assistive tech skip straight to the tile's own label.
      alt: '',
      aspect: aspectFromDims(width, height),
      width,
      height,
      sources: buildSources(slug, file),
      exif: formatExif(raw),
    };
  }));
}

export function getAlbumCover(slug: string): Photo | null {
  const dir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
  const file = effectiveCover(getAlbumInfo(slug), getOrderedFiles(slug));
  if (!file) return null;
  const { width = 1, height = 1 } = sizeOf(readFileSync(join(dir, file)));
  return {
    src: `/images/albums/${slug}/${DISPLAY_DIR}/${file}`,
    // Decorative, like the album's own photos: the link wrapping this cover
    // already carries the album name as text, so naming the image too would
    // just make a screen reader say it twice.
    alt: '',
    aspect: aspectFromDims(width, height),
    width,
    height,
    sources: buildSources(slug, file),
  };
}
