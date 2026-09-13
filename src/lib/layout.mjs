// Layout rules shared by everything that renders the photo grid: the built site
// (src/lib/albums.ts classifies aspects, PhotoGrid.astro lays out the masonry)
// and the local admin's live preview (scripts/admin.mjs), which serves this file
// straight to the browser at /layout.mjs. Previously each of the three carried
// its own copy of the thresholds and the packing algorithm; they agreed, but
// nothing kept them agreeing.
//
// Plain .mjs with no imports on purpose — it has to run unmodified in Node, in
// Vite's bundle, and as a bare <script type="module"> in the admin.

/** Above this width:height ratio a photo breaks out into its own full-width row. */
export const PANORAMA_THRESHOLD  = 1.52;
export const LANDSCAPE_THRESHOLD = 1.2;
export const PORTRAIT_THRESHOLD  = 0.85;

/** Relative row-heights used to balance columns — a portrait costs twice a landscape. */
export const ASPECT_HEIGHTS = { landscape: 0.75, portrait: 1.5, square: 1.0, panorama: 0.75 };

/**
 * @param {number} ratio width / height
 * @returns {'panorama' | 'landscape' | 'portrait' | 'square'}
 */
export function aspectFromRatio(ratio) {
  // The panorama cut-off sits slightly above 1.5 (not exactly) so a true 3:2
  // photo — the most common camera ratio — still reads as landscape after
  // integer-pixel rounding nudges it past 1.5 (e.g. 2000/1333 = 1.50037).
  if (ratio > PANORAMA_THRESHOLD)  return 'panorama';
  if (ratio > LANDSCAPE_THRESHOLD) return 'landscape';
  if (ratio < PORTRAIT_THRESHOLD)  return 'portrait';
  return 'square';
}

/**
 * @returns {'panorama' | 'landscape' | 'portrait' | 'square'}
 */
export function aspectFromDims(width, height) {
  return aspectFromRatio(width / height);
}

export function aspectHeight(aspect) {
  return ASPECT_HEIGHTS[aspect] ?? 1;
}

/**
 * The name shown for an album when info.json doesn't set one: strip any leading
 * sort prefix ("01-"), turn separators into spaces, and title-case it.
 */
export function toDisplayName(slug) {
  return slug
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const COVER_IMAGE_RE = /\.(jpg|jpeg|png|webp)$/i;

/**
 * The cover an album actually uses: the one named in info.json when it looks
 * like an image file, otherwise the first photo in display order.
 */
export function effectiveCover(info, photos) {
  const cover = info && info.cover;
  return cover && COVER_IMAGE_RE.test(cover) ? cover : photos[0];
}

/**
 * Plan a masonry layout without touching the DOM, so the site and the admin
 * preview can render the same arrangement into different markup.
 *
 * Panoramas break the flow and occupy a full-width row of their own; everything
 * between them is balanced across `columnCount` columns by accumulated height.
 *
 * @param {Array<{ aspect: string }>} items in display order
 * @param {number} columnCount
 * @returns {Array<{ type: 'panorama', item: any } | { type: 'row', columns: any[][] }>}
 */
export function planMasonry(items, columnCount) {
  const plan = [];
  let run = [];

  function flushRun() {
    if (!run.length) return;
    const columns = Array.from({ length: columnCount }, () => []);
    const heights = new Array(columnCount).fill(0);
    for (const item of run) {
      const shortest = heights.indexOf(Math.min(...heights));
      columns[shortest].push(item);
      heights[shortest] += aspectHeight(item.aspect);
    }
    plan.push({ type: 'row', columns });
    run = [];
  }

  for (const item of items) {
    if (item.aspect === 'panorama') {
      flushRun();
      plan.push({ type: 'panorama', item });
    } else {
      run.push(item);
    }
  }
  flushRun();

  return plan;
}
