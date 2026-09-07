import { createServer } from 'http';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'fs';
import { join, extname, basename } from 'path';
import { execFileSync } from 'child_process';

const PORT      = 4001;
const ALBUMS_DIR = join(process.cwd(), 'public/images/albums');
const DATA_DIR   = join(process.cwd(), 'src/data');
const CACHE_FILE = join(ALBUMS_DIR, '.optimize-cache.json');
const IMAGE_RE   = /\.(jpg|jpeg|png|webp)$/i;
const MIME       = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const DISPLAY_DIR = 'display';
// Keep in sync with DERIV_WIDTHS in scripts/optimize-images.mjs.
const DERIV_WIDTHS = [480, 960, 1440];

const ALBUM_ORDER_FILE = join(DATA_DIR, 'albums.json');

function timestamp() { return new Date().toTimeString().slice(0, 8); }
function log(msg) { console.log(`[${timestamp()}] ${msg}`); }
function logErr(action, err) { console.error(`[${timestamp()}] ✗ ${action} failed:`, err?.message ?? err); }

function getAlbumOrder() {
  try { return JSON.parse(readFileSync(ALBUM_ORDER_FILE, 'utf-8')).order ?? []; }
  catch { return []; }
}

function saveAlbumOrder(order) {
  writeFileSync(ALBUM_ORDER_FILE, JSON.stringify({ order }, null, 2) + '\n', 'utf-8');
  log(`Saved album order (${order.length})`);
}

function getAlbums() {
  const order = getAlbumOrder();
  const slugs = readdirSync(ALBUMS_DIR)
    .filter(n => !n.startsWith('.') && statSync(join(ALBUMS_DIR, n)).isDirectory())
    .sort()
    .sort((a, b) => {
      const ai = order.indexOf(a), bi = order.indexOf(b);
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
    });
  return slugs.map(slug => {
    let info = {};
    try { info = JSON.parse(readFileSync(join(ALBUMS_DIR, slug, 'info.json'), 'utf-8')); } catch {}
    const displayDir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
    const photos = existsSync(displayDir)
      ? readdirSync(displayDir).filter(f => IMAGE_RE.test(f) && !f.startsWith('.')).sort()
      : [];
    return { slug, info, photos };
  });
}

function saveInfo(slug, info) {
  writeFileSync(join(ALBUMS_DIR, slug, 'info.json'), JSON.stringify(info, null, 2) + '\n', 'utf-8');
  log(`Saved ${slug}/info.json`);
}

function readJSON(file)       { return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')); }
function writeJSON(file, data){ writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2) + '\n', 'utf-8'); log(`Saved src/data/${file}`); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 1960 + 1 }, (_, i) => CURRENT_YEAR - i);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Barlow', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; display: flex; height: 100vh; background: #fff; color: #1c1917; font-size: 14px; }
  body.dark { background: #0c0a09; color: #e7e5e4; }

  /* ── Sidebar ── */
  #sidebar { width: 256px; flex-shrink: 0; background: #fff; border-right: 1px solid #f5f5f4; overflow-y: auto; display: flex; flex-direction: column; padding: 40px 0 20px; }
  body.dark #sidebar { background: #0c0a09; border-right-color: #1c1917; }
  #sidebar-header { padding: 0 24px; margin-bottom: 40px; display: flex; flex-direction: column; align-items: center; }
  #site-name { font-size: 24px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.375; text-transform: uppercase; color: #a8a29e; text-align: center; margin-bottom: 6px; }
  #site-name:empty { display: none; }
  body.dark #site-name { color: #78716c; }
  .sidebar-header-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
  #sidebar-header h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; text-transform: uppercase; text-align: center; cursor: pointer; transition: opacity 0.15s; }
  #sidebar-header h1:hover { opacity: 0.7; }
  #sidebar-footer { margin-top: auto; padding: 20px 24px 0; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  #view-site-link { display: flex; align-items: center; gap: 6px; color: #a8a29e; font-size: 12px; text-decoration: none; transition: color 0.15s; }
  #view-site-link:hover { color: #1c1917; }
  body.dark #view-site-link:hover { color: #e7e5e4; }
  #theme-btn { background: none; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; color: #a8a29e; font-size: 12px; padding: 0; transition: color 0.15s; }
  #theme-btn:hover { color: #1c1917; }
  body.dark #theme-btn:hover { color: #e7e5e4; }
  .sidebar-section { padding: 0 0 24px; display: flex; flex-direction: column; align-items: stretch; }
  .sidebar-label { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #57534e; padding: 0 16px 14px; text-align: left; }
  body.dark .sidebar-label { color: #a8a29e; }
  .sidebar-hint { font-size: 11px; color: #a8a29e; padding: 0 16px 10px; }
  body.dark .sidebar-hint { color: #78716c; }
  .nav-item { padding: 3px 16px; cursor: pointer; color: #78716c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.1s; text-align: left; }
  body.dark .nav-item { color: #a8a29e; }
  .nav-item:hover { color: #1c1917; }
  body.dark .nav-item:hover { color: #e7e5e4; }
  .nav-item.active { color: #1c1917; font-weight: 700; }
  body.dark .nav-item.active { color: #e7e5e4; }

  /* ── Album nav list (draggable, numbered) ── */
  .album-nav-item { display: flex; align-items: center; gap: 8px; margin: 0 16px 6px; padding: 6px 10px; cursor: grab; color: #78716c; border: 1px solid #e7e5e4; border-radius: 8px; background: #fff; transition: color 0.1s, opacity 0.15s, border-color 0.15s; }
  body.dark .album-nav-item { color: #a8a29e; background: #1c1917; border-color: #292524; }
  .album-nav-item:hover { color: #1c1917; border-color: #d6d3d1; }
  body.dark .album-nav-item:hover { color: #e7e5e4; border-color: #44403c; }
  .album-nav-item.active { color: #1c1917; font-weight: 700; border-color: #1c1917; }
  body.dark .album-nav-item.active { color: #e7e5e4; border-color: #e7e5e4; }
  .album-nav-item.dragging { opacity: 0.35; cursor: grabbing; }
  #album-list { position: relative; }
  .drop-line-h { position: absolute; left: 16px; right: 16px; height: 2px; background: #1c1917; border-radius: 2px; pointer-events: none; z-index: 10; }
  body.dark .drop-line-h { background: #e7e5e4; }
  .album-drag-handle { flex-shrink: 0; cursor: grab; color: #d6d3d1; font-size: 13px; line-height: 1; user-select: none; }
  body.dark .album-drag-handle { color: #44403c; }
  .album-nav-item:active .album-drag-handle, .album-nav-item.dragging .album-drag-handle { cursor: grabbing; }
  .album-nav-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Main ── */
  #main { flex: 1; overflow-y: auto; }
  .editor { display: none; padding: 36px 44px 60px; max-width: 860px; position: relative; }
  .editor.visible { display: block; }
  .editor.drag-over { outline: 2px dashed #1c1917; outline-offset: -10px; background: rgba(28,25,23,0.03); }
  body.dark .editor.drag-over { outline-color: #e7e5e4; background: rgba(231,229,228,0.04); }
  .editor-title { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 4px; }
  .editor-sub { font-size: 12px; color: #a8a29e; margin-bottom: 28px; }

  /* ── Form fields ── */
  .field { margin-bottom: 18px; }
  .field label { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #78716c; margin-bottom: 6px; }
  .field input, .field textarea, .field select, input.bare, textarea.bare {
    width: 100%; padding: 8px 11px; border: 1px solid #d6d3d1; border-radius: 6px;
    font-size: 14px; font-family: inherit; color: #1c1917; background: #fff; outline: none; transition: border-color 0.15s;
  }
  .field select {
    appearance: none; -webkit-appearance: none;
    padding-right: 30px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a8a29e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; cursor: pointer;
  }
  body.dark .field select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2378716c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  }
  body.dark .field input, body.dark .field textarea, body.dark .field select,
  body.dark input.bare, body.dark textarea.bare { background: #292524; border-color: #44403c; color: #e7e5e4; }
  .field input:focus, .field textarea:focus, .field select:focus, input.bare:focus, textarea.bare:focus { border-color: #292524; box-shadow: 0 0 0 3px rgba(28,25,23,0.07); }
  body.dark .field input:focus, body.dark .field textarea:focus, body.dark input.bare:focus, body.dark textarea.bare:focus { border-color: #a8a29e; box-shadow: 0 0 0 3px rgba(168,162,158,0.1); }
  .field textarea, textarea.bare { resize: vertical; line-height: 1.6; }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  hr { border: none; border-top: 1px solid #e7e5e4; margin: 28px 0; }
  body.dark hr { border-top-color: #292524; }
  .section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #78716c; margin-bottom: 8px; }
  .section-hint { font-size: 11px; color: #a8a29e; margin-bottom: 14px; }

  /* ── Empty album prompt ── */
  .empty-prompt { display: none; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 60px 20px; border: 2px dashed #d6d3d1; border-radius: 10px; color: #a8a29e; }
  body.dark .empty-prompt { border-color: #44403c; }
  .empty-prompt.visible { display: flex; }
  #home-empty-prompt { display: flex; }
  .empty-prompt .empty-prompt-icon { font-size: 28px; color: #d6d3d1; margin-bottom: 10px; line-height: 1; }
  body.dark .empty-prompt .empty-prompt-icon { color: #44403c; }
  .empty-prompt p { font-size: 14px; max-width: 320px; }

  /* ── Order strip ── */
  #order-strip { position: relative; display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; margin-bottom: 8px; }
  .drop-line-v { position: absolute; width: 3px; background: #1c1917; border-radius: 3px; pointer-events: none; z-index: 10; }
  body.dark .drop-line-v { background: #e7e5e4; }
  .strip-item { position: relative; aspect-ratio: 1; border-radius: 5px; overflow: hidden; cursor: grab; border: 2px solid transparent; box-shadow: 0 0 0 0px transparent; transition: opacity 0.15s, border-color 0.15s, box-shadow 0.1s; }
  .strip-item img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
  .strip-item:hover { border-color: rgba(168,162,158,0.7); }
  .strip-item.cover-selected { border-color: #1c1917; }
  body.dark .strip-item.cover-selected { border-color: #e7e5e4; }
  .strip-item.dragging { opacity: 0.25; cursor: grabbing; }
  .strip-num { position: absolute; top: 3px; left: 4px; background: rgba(0,0,0,0.5); color: #fff; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; pointer-events: none; line-height: 1.4; }
  .cover-badge { position: absolute; bottom: 4px; left: 4px; background: rgba(0,0,0,0.65); color: #fff; font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; pointer-events: none; }
  .strip-delete { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); color: #fff; font-size: 13px; line-height: 1; border-radius: 50%; cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s; z-index: 2; }
  .strip-item:hover .strip-delete { opacity: 1; }
  .strip-delete:hover { background: #dc2626; }
  /* ── Masonry preview ── */
  .preview-label { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #78716c; margin-bottom: 8px; margin-top: 24px; }
  #masonry-preview { display: flex; flex-direction: column; gap: 8px; }
  .preview-row { display: flex; gap: 8px; align-items: flex-start; }
  .preview-col { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .preview-item { position: relative; border-radius: 4px; overflow: hidden; }
  .preview-item img { width: 100%; height: auto; display: block; }
  .preview-cover-badge { position: absolute; bottom: 5px; left: 5px; background: rgba(0,0,0,0.65); color: #fff; font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 5px; border-radius: 3px; }

  /* ── Floating mini preview (wide viewports only) ── */
  #mini-preview-panel { display: none; }
  @media (min-width: 1400px) {
    #mini-preview-panel.visible {
      display: block; position: fixed; top: 24px; right: 24px; width: 200px;
      max-height: calc(100vh - 48px); overflow-y: auto;
      background: #fff; border: 1px solid #e7e5e4; border-radius: 8px; padding: 12px; z-index: 30;
    }
    body.dark #mini-preview-panel.visible { background: #1c1917; border-color: #292524; }
  }
  .mini-preview-label { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #a8a29e; margin-bottom: 8px; }
  #mini-preview-grid { display: flex; flex-direction: column; gap: 4px; }
  #mini-preview-grid .preview-row { gap: 4px; }
  #mini-preview-grid .preview-col { gap: 4px; }
  #mini-preview-grid .preview-item { border-radius: 2px; }
  #mini-preview-grid .preview-cover-badge { display: none; }

  /* ── List items (bio paragraphs, projects) ── */
  .list-item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; border: 1px solid #e7e5e4; border-radius: 8px; padding: 12px; background: #fff; transition: border-color 0.15s, opacity 0.15s; }
  body.dark .list-item { background: #1c1917; border-color: #292524; }
  .list-item.dragging { opacity: 0.4; }
  .list-item.drag-over { border-color: #1c1917; box-shadow: 0 0 0 2px #1c1917; }
  body.dark .list-item.drag-over { border-color: #e7e5e4; box-shadow: 0 0 0 2px #e7e5e4; }
  .drag-handle { flex-shrink: 0; cursor: grab; color: #d6d3d1; font-size: 16px; line-height: 1; padding-top: 7px; user-select: none; }
  body.dark .drag-handle { color: #44403c; }
  .drag-handle:active { cursor: grabbing; }
  .item-fields { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .remove-btn { flex-shrink: 0; background: none; border: none; cursor: pointer; color: #d6d3d1; font-size: 20px; line-height: 1; padding: 2px 4px; border-radius: 4px; transition: color 0.15s; }
  .remove-btn:hover { color: #dc2626; }
  body.dark .remove-btn { color: #44403c; }
  body.dark .remove-btn:hover { color: #f87171; }
  .add-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 8px 14px; background: none; border: 1px dashed #d6d3d1; border-radius: 6px; color: #78716c; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .add-btn:hover { border-color: #1c1917; color: #1c1917; }
  body.dark .add-btn { border-color: #44403c; color: #a8a29e; }
  body.dark .add-btn:hover { border-color: #a8a29e; color: #e7e5e4; }
  input.proj-url { font-size: 12px; color: #78716c; }
  body.dark input.proj-url { color: #a8a29e; }

  /* ── Save row ── */
  .save-row { margin-top: 28px; display: flex; align-items: center; gap: 14px; }
  .save-btn { background: #1c1917; color: #fff; border: none; padding: 10px 22px; border-radius: 6px; font-size: 14px; font-weight: 700; cursor: pointer; transition: opacity 0.15s; }
  .save-btn:hover { opacity: 0.75; }
  .save-status { font-size: 13px; color: #16a34a; font-weight: 600; opacity: 0; transition: opacity 0.3s; }
  .save-status.show { opacity: 1; }
  .delete-album-btn { background: none; color: #dc2626; border: 1px solid #dc2626; padding: 9px 16px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.15s, color 0.15s; }
  .delete-album-btn:hover { background: #dc2626; color: #fff; }
</style>
</head>
<body>
<script>
  if (localStorage.getItem('admin-theme') !== 'light') document.body.classList.add('dark');
</script>

<div id="sidebar">
  <div id="sidebar-header">
    <div id="site-name"></div>
    <div class="sidebar-header-row">
      <h1 id="site-title-link" role="button" tabindex="0">Site Admin</h1>
    </div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-label">Pages</div>
    <div class="nav-item" data-page="home">Home</div>
    <div class="nav-item" data-page="about">About</div>
    <div class="nav-item" data-page="projects">Projects</div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-label">Albums</div>
    <div class="sidebar-hint">Drag to reorder &nbsp;·&nbsp; Click to edit</div>
    <div id="album-list"></div>
    <button class="add-btn" id="add-album-btn" style="margin-top:8px;">+ New Album</button>
  </div>
  <div id="sidebar-footer">
    <button id="theme-btn" aria-label="Toggle dark mode">
      <svg id="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <svg id="icon-sun"  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      <span id="theme-btn-label">Dark</span>
    </button>
    <a href="http://localhost:4321" id="view-site-link">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      View Site
    </a>
  </div>
</div>

<div id="main">
  <!-- ── Home editor ── -->
  <div id="home-editor" class="editor">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px;">
      <div class="editor-title" style="margin-bottom:0;">Home</div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
        <span class="save-status" id="home-save-status-top">Saved!</span>
        <button class="save-btn home-save-trigger">Save</button>
      </div>
    </div>
    <div class="editor-sub">src/data/about.json</div>
    <div class="field">
      <label>Site / Author Name</label>
      <input type="text" id="home-name" placeholder="Your Name" />
    </div>
    <div class="field">
      <label>Homepage Tagline</label>
      <input type="text" id="home-tagline" placeholder="Short one-line intro shown above the album grid" />
    </div>
    <hr>
    <div id="home-empty-prompt" class="empty-prompt">
      <div class="empty-prompt-icon">←</div>
      <p>Click an album or page in the menu on the left to start editing.</p>
    </div>
    <div class="save-row">
      <button class="save-btn home-save-trigger">Save</button>
      <span class="save-status" id="home-save-status">Saved!</span>
    </div>
  </div>

  <!-- ── Album editor ── -->
  <div id="album-editor" class="editor">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px;">
      <div class="editor-title" id="e-slug" style="margin-bottom:0;"></div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
        <span class="save-status" id="album-save-status">Saved!</span>
        <button class="save-btn album-save-trigger">Save</button>
        <button class="delete-album-btn" id="delete-album-btn">Delete Album</button>
      </div>
    </div>
    <div class="editor-sub" id="e-path"></div>
    <div class="field">
      <label>Album Name</label>
      <input type="text" id="e-name" placeholder="e.g. Portfolio" />
    </div>
    <div class="field-row">
      <div class="field">
        <label>Month</label>
        <select id="e-month">
          <option value="">— none —</option>
          ${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('\n          ')}
        </select>
      </div>
      <div class="field">
        <label>Year</label>
        <select id="e-year">
          <option value="">— none —</option>
          ${YEARS.map(y => `<option value="${y}">${y}</option>`).join('\n          ')}
        </select>
      </div>
    </div>
    <div class="field">
      <label>Description</label>
      <textarea id="e-desc" placeholder="One paragraph per line"></textarea>
    </div>
    <hr>
    <div class="section-hint" id="upload-status" style="display:none;"></div>
    <div id="album-empty-prompt" class="empty-prompt">
      <div class="empty-prompt-icon">＋</div>
      <p>Drag and drop images anywhere on this page to add your first photos.</p>
    </div>
    <div id="album-photos-section">
      <div class="section-label">Order</div>
      <div class="section-hint">Drag to reorder &nbsp;·&nbsp; Double-click to set cover &nbsp;·&nbsp; Drop image files anywhere here to add them</div>
      <div id="order-strip"></div>
      <div class="preview-label">Preview</div>
      <div id="masonry-preview"></div>
    </div>
    <div class="save-row">
      <button class="save-btn album-save-trigger">Save</button>
      <span class="save-status" id="album-save-status-bottom">Saved!</span>
    </div>
  </div>

  <!-- ── About editor ── -->
  <div id="about-editor" class="editor">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px;">
      <div class="editor-title" style="margin-bottom:0;">About</div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
        <span class="save-status" id="about-save-status-top">Saved!</span>
        <button class="save-btn about-save-trigger">Save</button>
      </div>
    </div>
    <div class="editor-sub">src/data/about.json</div>
    <div class="field">
      <label>Page Heading</label>
      <input type="text" id="about-heading" placeholder="About Me" />
    </div>
    <hr>
    <div class="section-label">Bio Paragraphs</div>
    <div class="section-hint">Drag to reorder</div>
    <div id="bio-list"></div>
    <button class="add-btn" id="add-para">+ Add Paragraph</button>
    <hr>
    <div class="section-label">Gear</div>
    <div class="section-hint">Drag to reorder</div>
    <div id="gear-list"></div>
    <button class="add-btn" id="add-gear">+ Add Gear</button>
    <div class="save-row">
      <button class="save-btn about-save-trigger">Save</button>
      <span class="save-status" id="about-save-status">Saved!</span>
    </div>
  </div>

  <!-- ── Projects editor ── -->
  <div id="projects-editor" class="editor">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px;">
      <div class="editor-title" style="margin-bottom:0;">Projects</div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
        <span class="save-status" id="projects-save-status-top">Saved!</span>
        <button class="save-btn projects-save-trigger">Save</button>
      </div>
    </div>
    <div class="editor-sub">src/data/projects.json</div>
    <div class="section-hint">Drag to reorder</div>
    <div id="projects-list"></div>
    <button class="add-btn" id="add-project">+ Add Project</button>
    <div class="save-row">
      <button class="save-btn projects-save-trigger">Save</button>
      <span class="save-status" id="projects-save-status">Saved!</span>
    </div>
  </div>
</div>

<div id="mini-preview-panel">
  <div class="mini-preview-label">Full Preview</div>
  <div id="mini-preview-grid"></div>
</div>

<script>
let albums = [], currentAlbum = null, currentView = null, dragSrc = null, aboutData = {};
function photoUrl(slug, f) { return '/albums/' + slug + '/display/' + f; }
// Smallest responsive derivative — used for thumbnails so we don't pull the
// full-size display image just to render a tiny preview. Falls back to the
// full image (via onerror) when no derivative exists for a file.
function thumbUrl(slug, f, width) { return '/albums/' + slug + '/resized/' + f.replace(/\.[^.]+$/, '') + '-' + width + 'w.webp'; }
const aspectCache = {};

// ── Boot ───────────────────────────────────────────────────────────────────
async function load() {
  albums = await fetch('/api/albums').then(r => r.json());
  renderSidebar();
  aboutData = await fetch('/api/about').then(r => r.json()).catch(() => ({}));
  document.getElementById('site-name').textContent = aboutData.name ?? '';
  selectHome();
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderSidebar() {
  if (window._sidebarCtrl) window._sidebarCtrl.abort();
  window._sidebarCtrl = new AbortController();
  const sig = window._sidebarCtrl.signal;

  const list = document.getElementById('album-list');
  list.innerHTML = '';

  const dropLine = document.createElement('div');
  dropLine.className = 'drop-line-h';
  dropLine.style.display = 'none';

  albums.forEach(a => {
    const row = document.createElement('div');
    row.className = 'album-nav-item' + (currentAlbum?.slug === a.slug ? ' active' : '');
    row.draggable = true;
    row.dataset.slug = a.slug;

    const handle = document.createElement('span');
    handle.className = 'album-drag-handle';
    handle.textContent = '⠿';

    const name = document.createElement('span');
    name.className = 'album-nav-name';
    name.textContent = a.slug;

    row.append(handle, name);
    row.addEventListener('click', () => { if (!dragSrc) selectAlbum(a.slug); });

    row.addEventListener('dragstart', e => {
      dragSrc = row;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => row.classList.add('dragging'), 0);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dropLine.style.display = 'none';
      dragSrc = null;
    });

    list.appendChild(row);
  });

  list.appendChild(dropLine);

  list.addEventListener('dragover', e => {
    const row = e.target.closest('.album-nav-item');
    if (!row || row === dragSrc) return;
    e.preventDefault();
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const before = e.clientY < rr.top + rr.height / 2;
    dropLine.style.top = ((before ? rr.top : rr.bottom) - lr.top - 1) + 'px';
    dropLine.style.display = '';
  }, { signal: sig });

  list.addEventListener('dragleave', e => {
    if (!list.contains(e.relatedTarget)) dropLine.style.display = 'none';
  }, { signal: sig });

  list.addEventListener('drop', e => {
    e.preventDefault();
    dropLine.style.display = 'none';
    if (!dragSrc) return;
    const row = e.target.closest('.album-nav-item');
    if (!row || row === dragSrc) return;
    const rr = row.getBoundingClientRect();
    const before = e.clientY < rr.top + rr.height / 2;
    list.insertBefore(dragSrc, before ? row : row.nextSibling);
    saveAlbumOrderFromDOM();
  }, { signal: sig });

  const pageHandlers = { home: selectHome, about: selectAbout, projects: selectProjects };
  document.querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === currentView);
    el.onclick = pageHandlers[el.dataset.page];
  });
}

async function saveAlbumOrderFromDOM() {
  const slugs = [...document.querySelectorAll('#album-list [data-slug]')].map(el => el.dataset.slug);
  albums.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
  await fetch('/api/album-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: slugs }),
  });
  renderSidebar();
}

function showEditor(id) {
  ['home-editor', 'album-editor', 'about-editor', 'projects-editor'].forEach(v =>
    document.getElementById(v).classList.toggle('visible', v === id)
  );
  if (id === 'album-editor') updateAlbumEmptyState();
  else document.getElementById('mini-preview-panel').classList.remove('visible');
}

// Toggle the order strip / preview / mini-preview vs. the drag-and-drop prompt
// based on whether the album has any photos yet.
function updateAlbumEmptyState() {
  if (!currentAlbum) return;
  const empty = currentAlbum.photos.length === 0;
  document.getElementById('album-empty-prompt').classList.toggle('visible', empty);
  document.getElementById('album-photos-section').style.display = empty ? 'none' : '';
  document.getElementById('mini-preview-panel').classList.toggle('visible', !empty);
}

function flashSaved(id) {
  const el = document.getElementById(id);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

// ── Generic drag-and-drop for .list-item lists ─────────────────────────────
function bindDrag(el, container, onChange) {
  el.addEventListener('dragstart', e => {
    dragSrc = el;
    setTimeout(() => el.classList.add('dragging'), 0);
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    container.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
    dragSrc = null;
  });
  el.addEventListener('dragover', e => {
    e.preventDefault();
    if (el !== dragSrc) {
      container.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    if (!dragSrc || dragSrc === el) return;
    const items = [...container.children];
    const from = items.indexOf(dragSrc), to = items.indexOf(el);
    container.insertBefore(dragSrc, from < to ? el.nextSibling : el);
    container.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
    onChange?.();
  });
}

// ── Album editor ───────────────────────────────────────────────────────────
async function selectAlbum(slug) {
  await flushAutosave();
  await homeAutosave.flush();
  await aboutAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = albums.find(a => a.slug === slug);
  currentView  = null;
  if (!currentAlbum) return;
  if (Array.isArray(currentAlbum.info.order) && currentAlbum.info.order.length) {
    const idx = {};
    currentAlbum.info.order.forEach((f, i) => { idx[f] = i; });
    currentAlbum.photos.sort((a, b) => (idx[a] ?? 9999) - (idx[b] ?? 9999));
  }
  renderSidebar();
  showEditor('album-editor');
  document.getElementById('e-slug').textContent  = currentAlbum.slug;
  document.getElementById('e-path').textContent  = 'public/images/albums/' + currentAlbum.slug;
  document.getElementById('e-name').value        = currentAlbum.info.name ?? '';
  document.getElementById('e-month').value       = currentAlbum.info.month ?? '';
  document.getElementById('e-year').value        = currentAlbum.info.year ?? '';
  const desc = currentAlbum.info.description;
  document.getElementById('e-desc').value = Array.isArray(desc) ? desc.join('\\n') : (desc ?? '');
  renderOrderStrip();
  renderMasonryPreview();
  document.getElementById('album-save-status').classList.remove('show');
  document.getElementById('album-save-status-bottom').classList.remove('show');
}

// Mirrors the live site's fallback in getAlbumCover(): the first photo in
// display order stands in as the cover whenever none is explicitly set.
function effectiveCover(info, photos) {
  return info.cover || photos[0];
}

// Keep in sync with aspectFromDims in src/lib/albums.ts and the aspectHeights
// bucket map in src/components/PhotoGrid.astro — matching how the live site
// categorizes and balances photos.
const PANORAMA_THRESHOLD = 1.52;
const LANDSCAPE_THRESHOLD = 1.2;
const PORTRAIT_THRESHOLD = 0.85;
const ASPECT_HEIGHTS = { landscape: 0.75, portrait: 1.5, square: 1.0 };

function aspectHeight(aspect) {
  if (aspect > LANDSCAPE_THRESHOLD) return ASPECT_HEIGHTS.landscape;
  if (aspect < PORTRAIT_THRESHOLD) return ASPECT_HEIGHTS.portrait;
  return ASPECT_HEIGHTS.square;
}

async function loadAspect(slug, file) {
  const key = slug + '/' + file;
  if (aspectCache[key]) return aspectCache[key];
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { aspectCache[key] = img.naturalWidth / img.naturalHeight; resolve(aspectCache[key]); };
    img.onerror = () => {
      // No small derivative for this file — fall back to the full image just to read its aspect ratio.
      const full = new Image();
      full.onload  = () => { aspectCache[key] = full.naturalWidth / full.naturalHeight; resolve(aspectCache[key]); };
      full.onerror = () => { aspectCache[key] = 1.33; resolve(aspectCache[key]); };
      full.src = photoUrl(slug, file);
    };
    img.src = thumbUrl(slug, file, 480);
  });
}

// Lay out pre-built items (each with a computed aspect ratio) into a 2-column
// masonry preview, matching the live site's algorithm: panoramas break out to
// full-width rows, everything else balances into the shorter column.
function layoutMasonryPreview(container, entries) {
  container.innerHTML = '';

  function flushRun(run) {
    if (!run.length) return;
    const row = document.createElement('div');
    row.className = 'preview-row';
    const cols = [0, 1].map(() => {
      const div = document.createElement('div');
      div.className = 'preview-col';
      row.appendChild(div);
      return div;
    });
    const heights = [0, 0];
    run.forEach(({ el, aspect }) => {
      const shortest = heights.indexOf(Math.min(...heights));
      cols[shortest].appendChild(el);
      heights[shortest] += aspectHeight(aspect);
    });
    container.appendChild(row);
  }

  let run = [];
  entries.forEach(entry => {
    if (entry.aspect > PANORAMA_THRESHOLD) {
      flushRun(run);
      run = [];
      container.appendChild(entry.el);
    } else {
      run.push(entry);
    }
  });
  flushRun(run);
}

function renderOrderStrip() {
  updateAlbumEmptyState();

  if (window._stripCtrl) window._stripCtrl.abort();
  window._stripCtrl = new AbortController();
  const sig = window._stripCtrl.signal;

  const { photos, slug, info } = currentAlbum;
  const strip = document.getElementById('order-strip');
  strip.innerHTML = '';
  const cover = effectiveCover(info, photos);

  // Declare first so dragend closures can reference it safely
  const dropLine = document.createElement('div');
  dropLine.className = 'drop-line-v';
  dropLine.style.display = 'none';

  photos.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'strip-item' + (f === cover ? ' cover-selected' : '');
    item.draggable = true;
    item.dataset.file = f;

    const img = document.createElement('img');
    img.src = thumbUrl(slug, f, 480);
    img.onerror = () => { img.onerror = null; img.src = photoUrl(slug, f); };
    img.draggable = false;
    item.appendChild(img);

    const num = document.createElement('span');
    num.className = 'strip-num';
    num.textContent = i + 1;
    item.appendChild(num);

    if (f === cover) {
      const badge = document.createElement('span');
      badge.className = 'cover-badge';
      badge.textContent = 'Cover';
      item.appendChild(badge);
    }

    const delBtn = document.createElement('div');
    delBtn.className = 'strip-delete';
    delBtn.textContent = '×';
    delBtn.title = 'Delete photo';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      deletePhoto(f);
    });
    item.appendChild(delBtn);

    item.addEventListener('dblclick', () => {
      if (dragSrc) return;
      currentAlbum.info.cover = f;
      strip.querySelectorAll('.strip-item').forEach(el => el.classList.remove('cover-selected'));
      strip.querySelectorAll('.cover-badge').forEach(b => b.remove());
      item.classList.add('cover-selected');
      const badge = document.createElement('span');
      badge.className = 'cover-badge';
      badge.textContent = 'Cover';
      item.appendChild(badge);
      renderMasonryPreview();
      autosaveAlbum();
    });

    item.addEventListener('dragstart', e => {
      dragSrc = item;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('dragging'), 0);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dropLine.style.display = 'none';
      dragSrc = null;
    });

    strip.appendChild(item);
  });

  strip.appendChild(dropLine);

  strip.addEventListener('dragover', e => {
    e.preventDefault();
    const item = e.target.closest('.strip-item');
    if (!item || item === dragSrc) return;
    const sr = strip.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    const before = e.clientX < ir.left + ir.width / 2;
    dropLine.style.left   = ((before ? ir.left : ir.right) - sr.left - 1.5) + 'px';
    dropLine.style.top    = (ir.top - sr.top) + 'px';
    dropLine.style.height = ir.height + 'px';
    dropLine.style.display = '';
  }, { signal: sig });

  strip.addEventListener('dragleave', e => {
    if (!strip.contains(e.relatedTarget)) dropLine.style.display = 'none';
  }, { signal: sig });

  strip.addEventListener('drop', e => {
    e.preventDefault();
    dropLine.style.display = 'none';
    if (!dragSrc) return;
    const item = e.target.closest('.strip-item');
    if (!item || item === dragSrc) return;
    const ir = item.getBoundingClientRect();
    const before = e.clientX < ir.left + ir.width / 2;
    strip.insertBefore(dragSrc, before ? item : item.nextSibling);
    strip.querySelectorAll('.strip-item').forEach((el, i) => {
      const n = el.querySelector('.strip-num');
      if (n) n.textContent = i + 1;
    });
    currentAlbum.photos = [...strip.querySelectorAll('.strip-item')].map(el => el.dataset.file);
    renderMasonryPreview();
    autosaveAlbum();
  }, { signal: sig });
}

async function renderMasonryPreview() {
  if (window._previewCtrl) window._previewCtrl.abort();
  window._previewCtrl = new AbortController();
  const sig = window._previewCtrl.signal;

  const { photos, slug, info } = currentAlbum;
  const cover = effectiveCover(info, photos);

  await Promise.all(photos.map(f => loadAspect(slug, f)));
  if (sig.aborted) return;

  function makeItem(f) {
    const item = document.createElement('div');
    item.className = 'preview-item';

    const img = document.createElement('img');
    img.src = thumbUrl(slug, f, 960);
    img.onerror = () => { img.onerror = null; img.src = photoUrl(slug, f); };
    item.appendChild(img);

    if (f === cover) {
      const badge = document.createElement('span');
      badge.className = 'preview-cover-badge';
      badge.textContent = 'Cover';
      item.appendChild(badge);
    }

    return item;
  }

  const container = document.getElementById('masonry-preview');
  const entries = photos.map(f => ({ el: makeItem(f), aspect: aspectCache[slug + '/' + f] ?? 1.33 }));
  layoutMasonryPreview(container, entries);

  document.getElementById('mini-preview-grid').innerHTML = container.innerHTML;
}

function buildAlbumInfo() {
  const name  = document.getElementById('e-name').value.trim();
  const month = document.getElementById('e-month').value;
  const year  = document.getElementById('e-year').value;
  const lines = document.getElementById('e-desc').value.split('\\n').map(l => l.trim()).filter(Boolean);
  const info  = {};
  if (name)  info.name  = name;
  if (month) info.month = Number(month);
  if (year)  info.year  = Number(year);
  if (lines.length === 1) info.description = lines[0];
  else if (lines.length > 1) info.description = lines;
  if (currentAlbum.info.cover) info.cover = currentAlbum.info.cover;
  if (currentAlbum.photos.length) info.order = [...currentAlbum.photos];
  return info;
}

async function saveAlbumInfo() {
  const info = buildAlbumInfo();
  await fetch('/api/albums/' + currentAlbum.slug, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
  currentAlbum.info = info;
  return info;
}

document.querySelectorAll('.album-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  if (!currentAlbum) return;
  await saveAlbumInfo();
  flashSaved('album-save-status');
  flashSaved('album-save-status-bottom');
}));

document.getElementById('delete-album-btn').addEventListener('click', async () => {
  if (!currentAlbum) return;
  const { slug, photos } = currentAlbum;
  const ok = confirm(
    'Delete the entire "' + slug + '" album?\\n\\n' +
    'This permanently deletes ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') +
    ' plus their originals and resized derivatives, and the album\\'s name/description/order — everything in ' +
    'public/images/albums/' + slug + '/. This cannot be undone.\\n\\n' +
    'Make sure you have the originals saved elsewhere before continuing.'
  );
  if (!ok) return;

  clearTimeout(autosaveTimer);
  autosavePending = false;

  await fetch('/api/albums/' + encodeURIComponent(slug), { method: 'DELETE' });

  albums = albums.filter(a => a.slug !== slug);
  selectHome();
});

// ── Autosave ──────────────────────────────────────────────────────────────────
// Reorder, cover, and field edits all save immediately (debounced for text
// fields) so switching albums never discards unsaved changes.
let autosaveTimer = null;
let autosavePending = false;

function autosaveAlbum() {
  if (!currentAlbum) return;
  autosavePending = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(flushAutosave, 600);
}

async function flushAutosave() {
  clearTimeout(autosaveTimer);
  if (!autosavePending || !currentAlbum) return;
  autosavePending = false;
  await saveAlbumInfo();
  flashSaved('album-save-status');
  flashSaved('album-save-status-bottom');
}

['e-name', 'e-desc'].forEach(id =>
  document.getElementById(id).addEventListener('input', autosaveAlbum)
);
['e-month', 'e-year'].forEach(id =>
  document.getElementById(id).addEventListener('change', autosaveAlbum)
);

// Generic debounced-autosave factory for the About/Projects editors (reorder,
// add, and remove act immediately; typing debounces) so switching pages never
// discards unsaved changes.
function makeAutosave(saveFn, statusIds) {
  let timer = null, pending = false;
  function trigger() {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 600);
  }
  async function flush() {
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    await saveFn();
    statusIds.forEach(flashSaved);
  }
  return { trigger, flush };
}

// ── About editor ───────────────────────────────────────────────────────────
function createParaItem(text) {
  const div    = document.createElement('div');
  div.className = 'list-item';
  div.draggable = true;

  const handle      = document.createElement('div');
  handle.className  = 'drag-handle';
  handle.textContent = '⠿';

  const fields = document.createElement('div');
  fields.className = 'item-fields';
  const ta     = document.createElement('textarea');
  ta.className = 'bare';
  ta.rows      = 3;
  ta.value     = text || '';
  ta.placeholder = 'Paragraph text...';
  ta.addEventListener('input', () => aboutAutosave.trigger());
  fields.appendChild(ta);

  const btn = document.createElement('button');
  btn.className   = 'remove-btn';
  btn.textContent = '×';
  btn.addEventListener('click', () => { div.remove(); aboutAutosave.trigger(); });

  div.append(handle, fields, btn);
  bindDrag(div, document.getElementById('bio-list'), () => aboutAutosave.trigger());
  return div;
}

function createGearItem(text) {
  const div    = document.createElement('div');
  div.className = 'list-item';
  div.draggable = true;

  const handle      = document.createElement('div');
  handle.className  = 'drag-handle';
  handle.textContent = '⠿';

  const fields = document.createElement('div');
  fields.className = 'item-fields';
  const input     = document.createElement('input');
  input.type      = 'text';
  input.className = 'bare';
  input.value     = text || '';
  input.placeholder = 'Camera, lens, etc...';
  input.addEventListener('input', () => aboutAutosave.trigger());
  fields.appendChild(input);

  const btn = document.createElement('button');
  btn.className   = 'remove-btn';
  btn.textContent = '×';
  btn.addEventListener('click', () => { div.remove(); aboutAutosave.trigger(); });

  div.append(handle, fields, btn);
  bindDrag(div, document.getElementById('gear-list'), () => aboutAutosave.trigger());
  return div;
}

// ── Home editor ───────────────────────────────────────────────────────────
async function selectHome() {
  await flushAutosave();
  await aboutAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = null;
  currentView  = 'home';
  renderSidebar();
  showEditor('home-editor');
  document.getElementById('home-name').value    = aboutData.name    ?? '';
  document.getElementById('home-tagline').value = aboutData.tagline ?? '';
  document.getElementById('home-save-status').classList.remove('show');
  document.getElementById('home-save-status-top').classList.remove('show');
}

async function saveHomeData() {
  aboutData = {
    ...aboutData,
    name:    document.getElementById('home-name').value.trim(),
    tagline: document.getElementById('home-tagline').value.trim(),
  };
  await fetch('/api/about', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aboutData) });
  document.getElementById('site-name').textContent = aboutData.name ?? '';
}

const homeAutosave = makeAutosave(saveHomeData, ['home-save-status', 'home-save-status-top']);

['home-name', 'home-tagline'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => homeAutosave.trigger())
);

document.querySelectorAll('.home-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  await saveHomeData();
  flashSaved('home-save-status');
  flashSaved('home-save-status-top');
}));

document.getElementById('site-title-link').addEventListener('click', selectHome);
document.getElementById('site-title-link').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectHome(); }
});

async function selectAbout() {
  await flushAutosave();
  await homeAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = null;
  currentView  = 'about';
  renderSidebar();
  showEditor('about-editor');
  document.getElementById('about-heading').value = aboutData.heading ?? '';
  const bioList = document.getElementById('bio-list');
  bioList.innerHTML = '';
  (aboutData.bio ?? []).forEach(p => bioList.appendChild(createParaItem(p)));
  const gearList = document.getElementById('gear-list');
  gearList.innerHTML = '';
  (aboutData.gear ?? []).forEach(g => gearList.appendChild(createGearItem(g)));
  document.getElementById('about-save-status').classList.remove('show');
  document.getElementById('about-save-status-top').classList.remove('show');
}

document.getElementById('add-para').addEventListener('click', () => {
  document.getElementById('bio-list').appendChild(createParaItem(''));
  aboutAutosave.trigger();
});

document.getElementById('add-gear').addEventListener('click', () => {
  document.getElementById('gear-list').appendChild(createGearItem(''));
  aboutAutosave.trigger();
});

async function saveAboutData() {
  aboutData = {
    ...aboutData,
    heading: document.getElementById('about-heading').value.trim(),
    bio:     [...document.getElementById('bio-list').querySelectorAll('textarea')]
               .map(t => t.value.trim()).filter(Boolean),
    gear:    [...document.getElementById('gear-list').querySelectorAll('input.bare')]
               .map(i => i.value.trim()).filter(Boolean),
  };
  await fetch('/api/about', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aboutData) });
}

const aboutAutosave = makeAutosave(saveAboutData, ['about-save-status', 'about-save-status-top']);

document.getElementById('about-heading').addEventListener('input', () => aboutAutosave.trigger());

document.querySelectorAll('.about-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  await saveAboutData();
  flashSaved('about-save-status');
  flashSaved('about-save-status-top');
}));

// ── Projects editor ────────────────────────────────────────────────────────
function createProjectCard(proj) {
  const div    = document.createElement('div');
  div.className = 'list-item';
  div.draggable = true;

  const handle      = document.createElement('div');
  handle.className  = 'drag-handle';
  handle.textContent = '⠿';

  const fields = document.createElement('div');
  fields.className = 'item-fields';

  const nameInput = document.createElement('input');
  nameInput.className   = 'bare proj-name';
  nameInput.placeholder = 'Project Name';
  nameInput.value       = proj?.name || '';

  const descInput = document.createElement('input');
  descInput.className   = 'bare proj-desc';
  descInput.placeholder = 'Short description';
  descInput.value       = proj?.description || '';

  const urlInput = document.createElement('input');
  urlInput.className   = 'bare proj-url';
  urlInput.type        = 'url';
  urlInput.placeholder = 'https://...';
  urlInput.value       = proj?.href || '';

  [nameInput, descInput, urlInput].forEach(input =>
    input.addEventListener('input', () => projectsAutosave.trigger())
  );
  fields.append(nameInput, descInput, urlInput);

  const btn = document.createElement('button');
  btn.className   = 'remove-btn';
  btn.textContent = '×';
  btn.addEventListener('click', () => { div.remove(); projectsAutosave.trigger(); });

  div.append(handle, fields, btn);
  bindDrag(div, document.getElementById('projects-list'), () => projectsAutosave.trigger());
  return div;
}

async function selectProjects() {
  await flushAutosave();
  await homeAutosave.flush();
  await aboutAutosave.flush();
  currentAlbum = null;
  currentView  = 'projects';
  renderSidebar();
  showEditor('projects-editor');
  const data = await fetch('/api/projects').then(r => r.json());
  const list = document.getElementById('projects-list');
  list.innerHTML = '';
  data.forEach(p => list.appendChild(createProjectCard(p)));
  document.getElementById('projects-save-status').classList.remove('show');
  document.getElementById('projects-save-status-top').classList.remove('show');
}

document.getElementById('add-project').addEventListener('click', () => {
  document.getElementById('projects-list').appendChild(createProjectCard(null));
  projectsAutosave.trigger();
});

async function saveProjectsData() {
  const projects = [...document.getElementById('projects-list').querySelectorAll('.list-item')].map(card => ({
    name:        card.querySelector('.proj-name').value.trim(),
    description: card.querySelector('.proj-desc').value.trim(),
    href:        card.querySelector('.proj-url').value.trim(),
  })).filter(p => p.name);
  await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(projects) });
}

const projectsAutosave = makeAutosave(saveProjectsData, ['projects-save-status', 'projects-save-status-top']);

document.querySelectorAll('.projects-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  await saveProjectsData();
  flashSaved('projects-save-status');
  flashSaved('projects-save-status-top');
}));

// ── Image upload (drag & drop) ───────────────────────────────────────────────
const albumEditorEl = document.getElementById('album-editor');
const uploadStatusEl = document.getElementById('upload-status');

function setUploadStatus(text) {
  uploadStatusEl.textContent = text;
  uploadStatusEl.style.display = text ? '' : 'none';
}

async function uploadFiles(files) {
  if (!currentAlbum) return;
  const images = [...files].filter(f => IMAGE_TYPES.test(f.name));
  if (!images.length) return;

  setUploadStatus('Uploading ' + images.length + ' image' + (images.length > 1 ? 's' : '') + '…');
  try {
    await Promise.all(images.map(file =>
      fetch(\`/api/albums/\${encodeURIComponent(currentAlbum.slug)}/upload?filename=\${encodeURIComponent(file.name)}\`, {
        method: 'POST',
        body: file,
      })
    ));

    setUploadStatus('Processing…');
    const res = await fetch(\`/api/albums/\${encodeURIComponent(currentAlbum.slug)}/process\`, { method: 'POST' });
    const { photos } = await res.json();

    const existing = new Set(currentAlbum.photos);
    const added = photos.filter(f => !existing.has(f));
    currentAlbum.photos = [...currentAlbum.photos, ...added];
    await saveAlbumInfo();

    renderOrderStrip();
    renderMasonryPreview();
    setUploadStatus('Added ' + added.length + ' image' + (added.length === 1 ? '' : 's'));
    flashSaved('album-save-status');
    flashSaved('album-save-status-bottom');
  } catch (err) {
    setUploadStatus('Upload failed — see console');
    console.error(err);
  } finally {
    setTimeout(() => setUploadStatus(''), 2500);
  }
}

const IMAGE_TYPES = /\\.(jpg|jpeg|png|webp)$/i;

async function deletePhoto(f) {
  if (!currentAlbum) return;
  const ok = confirm(
    'Delete "' + f + '"?\\n\\n' +
    'This permanently removes it from the album, originals, and resized folders on disk. ' +
    'Make sure you have a copy of the original saved elsewhere — this cannot be undone.'
  );
  if (!ok) return;

  setUploadStatus('Deleting…');
  try {
    await fetch(\`/api/albums/\${encodeURIComponent(currentAlbum.slug)}/photos/\${encodeURIComponent(f)}\`, { method: 'DELETE' });

    currentAlbum.photos = currentAlbum.photos.filter(p => p !== f);
    if (currentAlbum.info.cover === f) delete currentAlbum.info.cover;
    await saveAlbumInfo();

    renderOrderStrip();
    renderMasonryPreview();
    setUploadStatus('Deleted');
    flashSaved('album-save-status');
    flashSaved('album-save-status-bottom');
  } catch (err) {
    setUploadStatus('Delete failed — see console');
    console.error(err);
  } finally {
    setTimeout(() => setUploadStatus(''), 2500);
  }
}

['dragenter', 'dragover'].forEach(evt => albumEditorEl.addEventListener(evt, e => {
  if (!currentAlbum || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  albumEditorEl.classList.add('drag-over');
}));
albumEditorEl.addEventListener('dragleave', e => {
  if (e.target === albumEditorEl) albumEditorEl.classList.remove('drag-over');
});
albumEditorEl.addEventListener('drop', e => {
  e.preventDefault();
  albumEditorEl.classList.remove('drag-over');
  if (!currentAlbum || !e.dataTransfer.files.length) return;
  uploadFiles(e.dataTransfer.files);
});

// ── Theme ──────────────────────────────────────────────────────────────────
const themeBtn      = document.getElementById('theme-btn');
const iconMoon      = document.getElementById('icon-moon');
const iconSun       = document.getElementById('icon-sun');
const themeBtnLabel = document.getElementById('theme-btn-label');
if (localStorage.getItem('admin-theme') !== 'light') {
  document.body.classList.add('dark');
  iconMoon.style.display = 'none';
  iconSun.style.display  = '';
  themeBtnLabel.textContent = 'Light';
}
themeBtn.addEventListener('click', () => {
  const dark = document.body.classList.toggle('dark');
  iconMoon.style.display = dark ? 'none' : '';
  iconSun.style.display  = dark ? '' : 'none';
  themeBtnLabel.textContent = dark ? 'Light' : 'Dark';
  localStorage.setItem('admin-theme', dark ? 'dark' : 'light');
});

// ── New album ──────────────────────────────────────────────────────────────────
document.getElementById('add-album-btn').addEventListener('click', async () => {
  const input = prompt('Folder name for the new album (e.g. iceland-2026):');
  if (input === null) return;
  const slug = input.trim().split('/').pop();
  if (!slug) return;

  await flushAutosave();

  const res = await fetch('/api/albums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    alert('Could not create album' + (error ? ': ' + error : '.'));
    return;
  }

  albums = await fetch('/api/albums').then(r => r.json());
  await selectAlbum(slug);
});

load();
</script>
</body>
</html>`;

createServer((req, res) => {
  const rawPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  // Decode so non-ASCII album slugs (e.g. "Hawaiʻi") match the folder on disk.
  let path;
  try { path = decodeURIComponent(rawPath); } catch { path = rawPath; }

  if (path.startsWith('/albums/')) {
    const filePath = join(ALBUMS_DIR, path.slice('/albums/'.length));
    try {
      const stat = statSync(filePath);
      const lastModified = stat.mtime.toUTCString();
      const etag = '"' + stat.size + '-' + stat.mtimeMs + '"';

      if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
        res.writeHead(304);
        res.end();
        return;
      }

      const data = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'Last-Modified': lastModified,
        'ETag': etag,
      });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
    return;
  }

  function jsonGet(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function jsonPost(req, res, fn) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { fn(JSON.parse(body)); res.writeHead(200); res.end('{"ok":true}'); }
      catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message }));
        logErr(`POST ${path}`, err);
      }
    });
  }

  if (path === '/api/albums' && req.method === 'GET')  return jsonGet(res, getAlbums());
  if (path === '/api/albums' && req.method === 'POST') {
    return jsonPost(req, res, ({ slug: rawSlug }) => {
      const slug = basename(String(rawSlug ?? '').trim());
      if (!slug || slug.startsWith('.')) throw new Error('invalid slug');
      const dir = join(ALBUMS_DIR, slug);
      if (existsSync(dir)) throw new Error('album already exists');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'info.json'), '{}\n', 'utf-8');
      log(`Created album ${slug}`);
    });
  }

  if (path === '/api/album-order' && req.method === 'POST') {
    return jsonPost(req, res, ({ order }) => {
      if (!Array.isArray(order)) throw new Error('order must be an array');
      saveAlbumOrder(order.map(String));
    });
  }

  const albumM = path.match(/^\/api\/albums\/([^/]+)$/);
  if (albumM && req.method === 'POST') return jsonPost(req, res, d => saveInfo(albumM[1], d));
  if (albumM && req.method === 'DELETE') {
    const slug = decodeURIComponent(albumM[1]);
    try {
      rmSync(join(ALBUMS_DIR, slug), { recursive: true, force: true });
      try {
        const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        Object.keys(cache).forEach(k => {
          if (k === slug || k.startsWith(slug + '/') || k.startsWith('resized/' + slug + '/')) delete cache[k];
        });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      } catch {}
      saveAlbumOrder(getAlbumOrder().filter(s => s !== slug));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      log(`Deleted album ${slug}`);
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
      logErr(`delete album ${slug}`, err);
    }
    return;
  }

  const uploadM = path.match(/^\/api\/albums\/([^/]+)\/upload$/);
  if (uploadM && req.method === 'POST') {
    const slug = uploadM[1];
    const filename = basename(new URL(req.url, `http://localhost:${PORT}`).searchParams.get('filename') ?? '');
    if (!IMAGE_RE.test(filename)) { res.writeHead(400); return res.end('{"error":"unsupported file type"}'); }
    const originalsDir = join(ALBUMS_DIR, slug, 'originals');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        if (!existsSync(originalsDir)) mkdirSync(originalsDir, { recursive: true });
        writeFileSync(join(originalsDir, filename), Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        log(`Uploaded ${filename} to ${slug}/originals`);
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
        logErr(`upload ${filename} to ${slug}`, err);
      }
    });
    return;
  }

  const deleteM = path.match(/^\/api\/albums\/([^/]+)\/photos\/([^/]+)$/);
  if (deleteM && req.method === 'DELETE') {
    const slug = decodeURIComponent(deleteM[1]);
    const filename = basename(decodeURIComponent(deleteM[2]));
    const albumDir = join(ALBUMS_DIR, slug);
    const base = filename.replace(/\.[^.]+$/, '');
    try {
      [
        join(albumDir, DISPLAY_DIR, filename),
        join(albumDir, 'originals', filename),
        ...DERIV_WIDTHS.map(w => join(albumDir, 'resized', `${base}-${w}w.webp`)),
      ].forEach(p => { try { unlinkSync(p); } catch {} });

      try {
        const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        delete cache[`${slug}/${filename}`];
        delete cache[`resized/${slug}/${filename}`];
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      log(`Deleted photo ${filename} from ${slug}`);
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
      logErr(`delete photo ${filename} from ${slug}`, err);
    }
    return;
  }

  const processM = path.match(/^\/api\/albums\/([^/]+)\/process$/);
  if (processM && req.method === 'POST') {
    const slug = processM[1];
    try {
      log(`Running image optimizer (triggered by ${slug})…`);
      execFileSync('node', ['scripts/optimize-images.mjs'], { cwd: process.cwd(), stdio: 'inherit' });
      const displayDir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
      const photos = existsSync(displayDir)
        ? readdirSync(displayDir).filter(f => IMAGE_RE.test(f) && !f.startsWith('.')).sort()
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, photos }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
      logErr(`optimize images for ${slug}`, err);
    }
    return;
  }

  if (path === '/api/about' && req.method === 'GET')  return jsonGet(res, readJSON('about.json'));
  if (path === '/api/about' && req.method === 'POST') return jsonPost(req, res, d => writeJSON('about.json', d));

  if (path === '/api/projects' && req.method === 'GET')  return jsonGet(res, readJSON('projects.json'));
  if (path === '/api/projects' && req.method === 'POST') return jsonPost(req, res, d => writeJSON('projects.json', d));

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
}).listen(PORT, () => console.log(`Site admin → http://localhost:${PORT}`));
