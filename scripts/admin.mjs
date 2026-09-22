// The content editor: one file holding both its server and its whole browser
// client. It mounts into the Astro dev server at /admin — see
// scripts/admin-integration.mjs — so the site it edits is always the same
// origin serving it, and every URL below is relative to `base`.
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync, renameSync, createWriteStream } from 'fs';
import { join, extname, basename, resolve, sep } from 'path';
import { Script } from 'vm';
import { execFile } from 'child_process';

const ALBUMS_DIR = join(process.cwd(), 'public/images/albums');
// Layout rules shared with the built site; served to the browser as-is so the
// preview and the real grid can't drift apart. See src/lib/layout.mjs.
const LAYOUT_FILE = join(process.cwd(), 'src/lib/layout.mjs');
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

// Write through a temp file and rename over the target: rename is atomic within
// a filesystem, so a crash or a full disk can't leave one of the site's content
// files half-written. These files are the only copy of the content.
function writeFileAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  contentChanged();
}

// ── Live reload ──────────────────────────────────────────────────────────────
// The dev site holds an EventSource open here and reloads when the editor
// writes, so the two windows stay in step without anyone reaching for F5.
// Every JSON the editor saves goes through writeFileAtomic above; the routes
// that move image files around announce themselves.
//
// The subscriber list belongs to a handler rather than to the module, so that
// creating a handler twice in one process can't leave two of them writing to
// each other's clients. Only the newest is ever mounted: Astro restarts its dev
// server in-process when the config — or anything the config imports, which now
// includes this file — changes, and the module stays cached across that. So a
// new handler supersedes the old one, timer and all, instead of leaving it to
// tick over responses that closed long ago.
let active = null;

function setActiveHandler(next) {
  if (active) {
    clearInterval(active.keepalive);
    // The pending one too: a save can schedule a broadcast microseconds before a
    // restart tears the sockets down, and that timer would otherwise outlive the
    // handler and write to responses that no longer exist.
    clearTimeout(active.broadcastTimer());
  }
  active = next;
}

function contentChanged() {
  active?.broadcast();
}

// ── Publishing ───────────────────────────────────────────────────────────────
// Only the paths the editor itself writes. A half-finished code change in the
// working tree shouldn't ride along with a content publish — that's what a
// terminal is for.
const PUBLISH_PATHS = ['public/images/albums', 'src/data'];

function git(args) {
  return new Promise((resolve, reject) => {
    // execFile, never a shell: the commit message is user input, and a shell
    // would put it one quote away from being a command.
    execFile('git', args, {
      cwd: process.cwd(),
      maxBuffer: 10_000_000,
      env: {
        // A server has no terminal to prompt at. Left to itself git would sit
        // waiting for a username that can never arrive, taking this
        // single-threaded process down with it — the whole editor would freeze
        // on a click. Both of these turn that into an immediate, readable
        // error instead. Anything already in the environment wins, so someone
        // with their own askpass setup keeps it.
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        ...process.env,
      },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Anything that isn't a hard error — returns null rather than throwing, for
// the parts of the status that are allowed to be missing.
async function gitTry(args) {
  try { return (await git(args)).trim(); } catch { return null; }
}

async function gitStatus() {
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  // -uall lists the files inside a new album rather than collapsing it to the
  // directory, so the panel can say how many photos are about to go out.
  const out = await git(['status', '--porcelain', '-uall', '--', ...PUBLISH_PATHS]);
  const changes = out.split('\n').filter(Boolean).map(line => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3).replace(/^"|"$/g, ''),
  }));

  // Where a push would actually land. A fork's origin is the fork; a clone of
  // someone else's repo points at theirs, which is worth seeing before you
  // press the button rather than in the error afterwards.
  const upstream = await gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remoteName = upstream
    ? upstream.split('/')[0]
    : ((await gitTry(['remote'])) || '').split('\n').filter(Boolean)[0] ?? null;
  const remoteUrl = remoteName ? await gitTry(['remote', 'get-url', remoteName]) : null;

  // The first commit in a fresh clone fails outright without these, so say so
  // up front instead of after the files are staged.
  const identity = Boolean(await gitTry(['config', 'user.name']) && await gitTry(['config', 'user.email']));

  return {
    branch,
    changes,
    upstream,
    identity,
    remote: remoteName,
    // A remote URL can carry a token (https://user:token@host/…). Strip any
    // credentials before this goes anywhere near the page.
    remoteUrl: remoteUrl ? remoteUrl.replace(/\/\/[^@/]*@/, '//') : null,
  };
}

async function gitPublish(message) {
  const { upstream, remote, identity } = await gitStatus();
  if (!identity) {
    throw new Error('git needs an identity first:\n  git config user.name "Your Name"\n  git config user.email you@example.com');
  }
  if (!upstream && !remote) {
    throw new Error('no git remote to push to — add one with:\n  git remote add origin <url>');
  }

  await git(['add', '--', ...PUBLISH_PATHS]);
  const staged = (await git(['diff', '--cached', '--name-only'])).trim();
  if (!staged) throw new Error('nothing to publish');
  await git(['commit', '-m', message]);
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  // A branch that has never been pushed has nothing to push to; -u names the
  // target once and every publish after this one is a plain push.
  await git(upstream ? ['push'] : ['push', '-u', remote, 'HEAD']);
  log(`Published ${sha}: ${message}`);
  return { sha, files: staged.split('\n').length };
}

// The route patterns use [^/]+ so a slug can't contain a separator, but "." and
// ".." would still climb out of ALBUMS_DIR. Returns null for anything unsafe.
function safeSlug(raw) {
  const slug = basename(String(raw ?? ''));
  return slug && !slug.startsWith('.') ? slug : null;
}

function getAlbumOrder() {
  try { return JSON.parse(readFileSync(ALBUM_ORDER_FILE, 'utf-8')).order ?? []; }
  catch { return []; }
}

function saveAlbumOrder(order) {
  writeFileAtomic(ALBUM_ORDER_FILE, JSON.stringify({ order }, null, 2) + '\n');
  log(`Saved album order (${order.length})`);
}

// Derivative filenames are <base>-<width>w-<hash>.<ext> (see
// scripts/optimize-images.mjs). Matched from the right, because a base name can
// itself contain dashes.
const DERIVATIVE_RE = /^(.*)-(\d+)w-[0-9a-f]{8}\.(avif|webp)$/;

// The content hash means the browser can't build a derivative's URL from the
// photo's name, so the editor is told which ones exist: { <photo>: { <width>:
// <filename> } }. WebP only — one URL per width is all a thumbnail needs.
function getThumbs(slug, photos) {
  const dir = join(ALBUMS_DIR, slug, 'resized');
  if (!existsSync(dir)) return {};
  const byBase = new Map(photos.map(f => [f.replace(/\.[^.]+$/, ''), f]));
  const thumbs = {};
  for (const name of readdirSync(dir)) {
    const m = DERIVATIVE_RE.exec(name);
    if (!m || m[3] !== 'webp') continue;
    const photo = byBase.get(m[1]);
    if (!photo) continue;
    (thumbs[photo] ??= {})[m[2]] = name;
  }
  return thumbs;
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
    return { slug, info, photos, thumbs: getThumbs(slug, photos) };
  });
}

function saveInfo(slug, info) {
  writeFileAtomic(join(ALBUMS_DIR, slug, 'info.json'), JSON.stringify(info, null, 2) + '\n');
  log(`Saved ${slug}/info.json`);
}

function readJSON(file)       { return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')); }
function writeJSON(file, data){ writeFileAtomic(join(DATA_DIR, file), JSON.stringify(data, null, 2) + '\n'); log(`Saved src/data/${file}`); }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 1960 + 1 }, (_, i) => CURRENT_YEAR - i);

// Rendered once per handler, not per request. `base` is where this page is
// mounted inside the dev server.
function renderShell({ base }) {
  return `<!DOCTYPE html>
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
  .site-logo { display: inline-block; cursor: pointer; transition: opacity 0.15s; text-align: center; }
  .site-logo:hover { opacity: 0.8; }
  #site-name { font-size: 24px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.375; text-transform: uppercase; color: #1c1917; }
  #site-name:empty { display: none; }
  body.dark #site-name { color: #e7e5e4; }
  .site-logo-strip { display: flex; height: 5px; margin: 6px 0 8px; }
  #site-name:empty ~ .site-logo-strip { display: none; }
  .site-logo-strip span { flex: 1; }
  #sidebar-header h1 { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #a8a29e; }
  body.dark #sidebar-header h1 { color: #78716c; }
  #sidebar-footer { margin-top: auto; padding: 20px 24px 56px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  /* Pinned bottom-left, the same corner the site's Admin pill uses, so hopping
     between the two is one spot to aim at rather than two. Above the mini
     preview panel (z-index 30) — it's the one control that must stay clickable. */
  #view-site-link {
    position: fixed; bottom: 20px; left: 20px; z-index: 40;
    display: flex; align-items: center; gap: 6px;
    padding: 8px 13px; border-radius: 999px;
    border: 1px solid #e7e5e4; background: rgba(255,255,255,0.92); backdrop-filter: blur(6px);
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    color: #78716c; font-size: 12px; font-weight: 600; text-decoration: none;
    transition: color 0.15s, border-color 0.15s;
  }
  #view-site-link:hover { color: #1c1917; border-color: #d6d3d1; }
  body.dark #view-site-link { background: rgba(28,25,23,0.92); border-color: #292524; color: #a8a29e; }
  body.dark #view-site-link:hover { color: #e7e5e4; border-color: #44403c; }

  /* ── Publish ── */
  #publish-btn { background: none; border: 1px solid #d6d3d1; border-radius: 999px; padding: 7px 16px; font: inherit; font-size: 12px; font-weight: 700; color: #57534e; cursor: pointer; transition: all 0.15s; }
  #publish-btn:hover:not(:disabled) { border-color: #1c1917; color: #1c1917; }
  #publish-btn:disabled { opacity: 0.4; cursor: default; }
  body.dark #publish-btn { border-color: #44403c; color: #a8a29e; }
  body.dark #publish-btn:hover:not(:disabled) { border-color: #a8a29e; color: #e7e5e4; }
  #publish-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #d97706; margin-right: 6px; vertical-align: middle; }
  #publish-panel {
    display: none; position: fixed; left: 20px; bottom: 72px; z-index: 45; width: 340px;
    background: #fff; border: 1px solid #e7e5e4; border-radius: 10px; padding: 16px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  }
  #publish-panel.open { display: block; }
  body.dark #publish-panel { background: #1c1917; border-color: #292524; }
  .publish-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #57534e; margin-bottom: 4px; }
  body.dark .publish-title { color: #a8a29e; }
  .publish-target { font-size: 11px; color: #a8a29e; margin-bottom: 12px; }
  .publish-target strong { color: #b45309; }
  #publish-changes { max-height: 180px; overflow-y: auto; margin-bottom: 12px; font-size: 11px; line-height: 1.7; color: #78716c; }
  #publish-changes div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .publish-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  #publish-status { font-size: 11px; color: #78716c; margin-top: 10px; word-break: break-word; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
  #publish-status.error { color: #dc2626; }
  #publish-status.ok { color: #16a34a; }
  #theme-btn { background: none; border: none; cursor: pointer; display: flex; align-items: center; gap: 8px; color: #a8a29e; font-size: 12px; padding: 0; transition: color 0.15s; }
  #theme-btn:hover { color: #1c1917; }
  body.dark #theme-btn:hover { color: #e7e5e4; }
  .sidebar-section { padding: 0 0 24px; display: flex; flex-direction: column; align-items: stretch; }
  .sidebar-label { font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #57534e; padding: 0 16px 14px; text-align: left; }
  body.dark .sidebar-label { color: #a8a29e; }
  .sidebar-hint { font-size: 11px; color: #a8a29e; padding: 0 16px 10px; }
  body.dark .sidebar-hint { color: #78716c; }
  .nav-item { padding: 5px 16px; font-size: 16px; cursor: pointer; color: #78716c; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color 0.1s; text-align: left; }
  body.dark .nav-item { color: #a8a29e; }
  .nav-item:hover { color: #1c1917; }
  body.dark .nav-item:hover { color: #e7e5e4; }
  .nav-item.active { color: #1c1917; font-weight: 700; }
  body.dark .nav-item.active { color: #e7e5e4; }

  /* ── Album nav list (draggable, numbered) ── */
  .album-nav-item { display: flex; align-items: center; gap: 8px; margin: 0 16px 7px; padding: 8px 11px; font-size: 16px; cursor: grab; color: #78716c; border: 1px solid #e7e5e4; border-radius: 8px; background: #fff; transition: color 0.1s, opacity 0.15s, border-color 0.15s; }
  body.dark .album-nav-item { color: #a8a29e; background: #1c1917; border-color: #292524; }
  .album-nav-item:hover { color: #1c1917; border-color: #d6d3d1; }
  body.dark .album-nav-item:hover { color: #e7e5e4; border-color: #44403c; }
  .album-nav-item.active { color: #1c1917; font-weight: 700; border-color: #1c1917; }
  body.dark .album-nav-item.active { color: #e7e5e4; border-color: #e7e5e4; }
  .album-nav-item.dragging { opacity: 0.35; cursor: grabbing; }
  #album-list { position: relative; }
  .drop-line-h { position: absolute; left: 16px; right: 16px; height: 2px; background: #1c1917; border-radius: 2px; pointer-events: none; z-index: 10; }
  body.dark .drop-line-h { background: #e7e5e4; }
  .album-drag-handle { flex-shrink: 0; cursor: grab; color: #d6d3d1; font-size: 14px; line-height: 1; user-select: none; }
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
  .back-link { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; margin-bottom: 14px; font: inherit; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #a8a29e; cursor: pointer; transition: color 0.1s; }
  .back-link:hover { color: #1c1917; }
  body.dark .back-link:hover { color: #e7e5e4; }
  .editor-sub { font-size: 12px; color: #a8a29e; margin-bottom: 28px; }

  /* ── Form fields ── */
  .field { margin-bottom: 18px; }
  .field label { display: block; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #78716c; margin-bottom: 6px; }
  .field input, .field textarea, .field select, input.bare, textarea.bare, select.bare {
    width: 100%; padding: 8px 11px; border: 1px solid #d6d3d1; border-radius: 6px;
    font-size: 14px; font-family: inherit; color: #1c1917; background: #fff; outline: none; transition: border-color 0.15s;
  }
  .field select, select.bare {
    appearance: none; -webkit-appearance: none;
    padding-right: 30px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a8a29e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center; cursor: pointer;
  }
  body.dark .field select, body.dark select.bare {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2378716c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  }
  body.dark .field input, body.dark .field textarea, body.dark .field select,
  body.dark input.bare, body.dark textarea.bare, body.dark select.bare { background: #292524; border-color: #44403c; color: #e7e5e4; }
  .field input:focus, .field textarea:focus, .field select:focus, input.bare:focus, textarea.bare:focus, select.bare:focus { border-color: #292524; box-shadow: 0 0 0 3px rgba(28,25,23,0.07); }
  body.dark .field input:focus, body.dark .field textarea:focus, body.dark input.bare:focus, body.dark textarea.bare:focus, body.dark select.bare:focus { border-color: #a8a29e; box-shadow: 0 0 0 3px rgba(168,162,158,0.1); }
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
  #album-sort-strip { position: relative; display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; margin-bottom: 8px; }

  /* ── Homepage preview (mirrors index.astro's forced-even grid + title-overlay tiles) ── */
  #home-masonry-preview { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .home-preview-item { position: relative; aspect-ratio: 4 / 3; border-radius: 4px; overflow: hidden; cursor: pointer; }
  .home-preview-item:hover { outline: 2px solid #0ea5e9; outline-offset: 1px; }
  .home-preview-item:hover .home-preview-overlay { background: rgba(0,0,0,0.5); }
  .home-preview-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .home-preview-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.35); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 12px; }
  .home-preview-title { color: #fff; font-weight: 800; text-transform: uppercase; letter-spacing: -0.02em; line-height: 0.9; font-size: clamp(14px, 4vw, 26px); word-break: break-word; }
  .home-preview-date { color: rgba(255,255,255,0.8); font-weight: 600; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; margin-top: 8px; }
  /* ── Masonry preview ── */
  .preview-label { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #78716c; margin-bottom: 8px; margin-top: 24px; }
  #masonry-preview { display: flex; flex-direction: column; gap: 8px; }
  .preview-row { display: flex; gap: 8px; align-items: flex-start; }
  .preview-col { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .preview-item { position: relative; border-radius: 4px; overflow: hidden; }
  .preview-item img { width: 100%; height: auto; display: block; }
  #masonry-preview .preview-item { cursor: pointer; }
  #masonry-preview .preview-item:hover { outline: 2px solid #0ea5e9; outline-offset: -2px; }
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
  .save-status.error { color: #dc2626; }
  .delete-album-btn { background: none; color: #dc2626; border: 1px solid #dc2626; padding: 9px 16px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.15s, color 0.15s; }
  .delete-album-btn:hover { background: #dc2626; color: #fff; }
</style>
</head>
<body>
<script>
  // Apply the theme before paint. The cookie is what the live site writes too —
  // cookies are shared across ports on a host, localStorage isn't — so the two
  // stay in sync; localStorage is only the fallback for a first visit.
  (function () {
    var c = document.cookie.match(/(?:^|;\\s*)theme=(dark|light)/);
    var pref = c ? c[1] : localStorage.getItem('admin-theme');
    if (pref !== 'light') document.body.classList.add('dark');
  })();
</script>

<div id="sidebar">
  <div id="sidebar-header">
    <div id="site-title-link" role="button" tabindex="0" class="site-logo">
      <div id="site-name"></div>
      <div class="site-logo-strip">
        <span style="background:#c2542f"></span>
        <span style="background:#d9a441"></span>
        <span style="background:#2f6f6a"></span>
        <span style="background:#7a8b4f"></span>
        <span style="background:#a8433a"></span>
        <span style="background:#c9a066"></span>
      </div>
      <h1>Site Admin</h1>
    </div>
  </div>
  <div class="sidebar-section">
    <div class="sidebar-label">Pages</div>
    <div class="nav-item" data-page="home">Home/Album Index</div>
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
    <button id="publish-btn" disabled>Publish</button>
    <button id="theme-btn" aria-label="Toggle dark mode">
      <svg id="icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <svg id="icon-sun"  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      <span id="theme-btn-label">Dark</span>
    </button>
  </div>
</div>

<!-- Fixed to the viewport, so it's outside the sidebar it used to sit in. The
     href tracks the editor's route (see syncUrl) — editing an album and
     clicking this lands on that album, not the homepage. -->
<a href="/" id="view-site-link">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
  View Site
</a>

<!-- Publishing commits and pushes the content paths only (see PUBLISH_PATHS),
     so the list below is the whole of what goes out. -->
<div id="publish-panel">
  <div class="publish-title">Publish</div>
  <div class="publish-target" id="publish-target"></div>
  <div id="publish-changes"></div>
  <input type="text" id="publish-message" class="bare" placeholder="Describe the change" maxlength="100">
  <div class="publish-actions">
    <button class="save-btn" id="publish-confirm" style="padding:8px 18px;font-size:13px;">Publish</button>
    <button class="add-btn" id="publish-cancel" style="margin-top:0;padding:7px 14px;">Cancel</button>
  </div>
  <div id="publish-status"></div>
</div>

<div id="main">
  <!-- ── Home editor ── -->
  <div id="home-editor" class="editor">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:4px;">
      <div class="editor-title" style="margin-bottom:0;">Home/Album Index</div>
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
      <p>Create an album from the sidebar to start building your homepage.</p>
    </div>
    <div id="home-albums-section">
      <div class="section-label">Album Order</div>
      <div class="section-hint">Drag to reorder (Controls homepage &amp; menu order) &nbsp;·&nbsp; Double click to edit album</div>
      <div id="album-sort-strip"></div>
      <div class="preview-label">Homepage Preview</div>
      <div class="section-hint">Click an album to edit it</div>
      <div id="home-masonry-preview"></div>
    </div>
    <div class="save-row">
      <button class="save-btn home-save-trigger">Save</button>
      <span class="save-status" id="home-save-status">Saved!</span>
    </div>
  </div>

  <!-- ── Album editor ── -->
  <div id="album-editor" class="editor">
    <button class="back-link" id="album-back-btn">← Home/Album Index</button>
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
      <div class="section-hint">Double-click a photo to set it as the cover</div>
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
    <hr>
    <div class="section-label">Socials</div>
    <div class="section-hint">Drag to reorder</div>
    <div id="socials-list"></div>
    <button class="add-btn" id="add-social">+ Add Social</button>
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

<script type="module">
// The aspect thresholds, the display-name fallback, the cover rule and the
// masonry packing all come from the same file the built site uses, served by
// this server — so the preview below can't drift from the real grid. See
// src/lib/layout.mjs. The specifier is baked in at render time, which is why a
// static import can carry what is otherwise a runtime value.
import { aspectFromRatio, toDisplayName, effectiveCover, planMasonry } from '${base}/layout.mjs';

// Where this editor is mounted. Everything the page requests is built from it,
// so the mount point is configurable (adminPanel({ base }) in astro.config.mjs)
// without a single URL in here being hardcoded to /admin.
const BASE = ${JSON.stringify(base)};
const API = BASE + '/api';
const ASSET_BASE = BASE + '/albums';

let albums = [], currentAlbum = null, currentView = null, dragSrc = null, aboutData = {}, socialsData = [];
function photoUrl(slug, f) { return ASSET_BASE + '/' + slug + '/display/' + f; }
// Smallest responsive derivative at or above the width we need — so a tiny
// preview doesn't pull the full-size display image. Derivative names carry a
// content hash and can't be guessed, so they come from the album payload;
// photos with none yet (just uploaded, or smaller than 480px) use the full
// image, which is also what the onerror fallbacks below catch.
function thumbUrl(slug, f, width) {
  const byWidth = albums.find(a => a.slug === slug)?.thumbs?.[f];
  const widths = Object.keys(byWidth ?? {}).map(Number).sort((a, b) => a - b);
  const w = widths.find(x => x >= width) ?? widths[widths.length - 1];
  return w === undefined ? photoUrl(slug, f) : ASSET_BASE + '/' + slug + '/resized/' + byWidth[w];
}
function albumDisplayName(a) {
  return a.info.name || toDisplayName(a.slug);
}
const aspectCache = {};

// ── Routing ────────────────────────────────────────────────────────────────
// Every editor view has its own URL (/, /about, /projects, /album/<slug>) so
// back/forward, reload, and deep links all work. The server serves this same
// page for any path it doesn't recognise as an API route or album asset, so a
// hard load of /album/san-francisco renders straight into that album.
const TITLES = { home: 'Homepage', about: 'About', projects: 'Projects' };

// The same route on the site: what the "View Site" pill points at. The site is
// whatever is serving this page, so these are plain relative links.
function sitePath(view, slug) {
  if (view === 'album')    return '/albums/' + encodeURIComponent(slug);
  if (view === 'about')    return '/about';
  if (view === 'projects') return '/projects';
  return '/';
}

function routePath(view, slug) {
  if (view === 'album')    return BASE + '/album/' + encodeURIComponent(slug);
  if (view === 'about')    return BASE + '/about';
  if (view === 'projects') return BASE + '/projects';
  // BASE itself, not BASE + '/': a site configured with trailingSlash 'never'
  // would redirect (and then 404) the trailing form.
  return BASE || '/';
}

function parseRoute() {
  let path;
  try { path = decodeURIComponent(location.pathname); } catch { path = location.pathname; }
  // Match against the path within the editor, so these regexes don't care what
  // the mount point is.
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
  const m = path.match(/^\\/album\\/(.+?)\\/?$/);
  if (m) return { view: 'album', slug: m[1] };
  if (/^\\/about\\/?$/.test(path))    return { view: 'about' };
  if (/^\\/projects\\/?$/.test(path)) return { view: 'projects' };
  return { view: 'home' };
}

// hist: 'push' (a normal in-app navigation), 'replace' (correct the URL
// without adding an entry), or false (rendering what the URL already says,
// e.g. a popstate — leave history alone).
function syncUrl(hist, view, slug) {
  document.title = 'Site Admin — ' + (view === 'album' ? slug : TITLES[view]);
  // Before the early return: a popstate changes the route without touching
  // history, and the pill still has to follow it.
  document.getElementById('view-site-link').href = sitePath(view, slug);
  if (!hist) return;
  const path = routePath(view, slug);
  // Skip a history write that wouldn't change where we are — re-selecting the
  // current view shouldn't stack a duplicate entry, and arriving at /admin/
  // shouldn't be "corrected" to /admin. parseRoute reads both the same way, so
  // the rewrite bought nothing, and rewriting the URL on every single load
  // hands anything watching the history API something to react to: a browser
  // extension doing exactly that turned it into a reload loop, each rewrite
  // answered by a navigation back to the URL it had.
  // No regex here on purpose: this whole page is a template literal, where a
  // backslash needs doubling, and /\/$/ collapses to // — a comment that eats
  // the rest of the script.
  const trim = p => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  if (trim(location.pathname) === trim(path)) return;
  history[hist === 'replace' ? 'replaceState' : 'pushState']({ view, slug: slug ?? null }, '', path);
}

// Render whichever view the current URL names. Used on first load and on
// back/forward; an unknown album slug falls back to the homepage editor.
function renderRoute(hist) {
  const r = parseRoute();
  if (r.view === 'album') {
    if (albums.some(a => a.slug === r.slug)) return selectAlbum(r.slug, hist);
    return selectHome('replace');
  }
  if (r.view === 'about')    return selectAbout(hist);
  if (r.view === 'projects') return selectProjects(hist);
  return selectHome(hist);
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function load() {
  albums = await fetch(API + '/albums').then(r => r.json());
  renderSidebar();
  aboutData = await fetch(API + '/about').then(r => r.json()).catch(() => ({}));
  document.getElementById('site-name').textContent = aboutData.name ?? '';
  window.addEventListener('popstate', () => renderRoute(false));
  renderRoute('replace');
  refreshPublishState();
  // Coming back to this tab is when a stale answer is most likely — a publish
  // may have happened elsewhere.
  window.addEventListener('focus', refreshPublishState);
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
    saveAlbumOrder([...list.querySelectorAll('[data-slug]')].map(el => el.dataset.slug));
  }, { signal: sig });

  const pageHandlers = { home: selectHome, about: selectAbout, projects: selectProjects };
  document.querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === currentView);
    el.onclick = () => pageHandlers[el.dataset.page]();
  });
}

async function saveAlbumOrder(slugs) {
  albums.sort((a, b) => slugs.indexOf(a.slug) - slugs.indexOf(b.slug));
  try {
    await postJSON(API + '/album-order', { order: slugs });
  } catch (err) {
    reportSaveError(['home-save-status', 'home-save-status-top'], err);
  }
  renderSidebar();
  if (currentView === 'home') {
    updateHomeEmptyState();
    renderAlbumSortStrip();
    renderHomeMasonryPreview();
  }
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
  el.textContent = 'Saved!';
  el.classList.remove('error');
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

// Every write goes through here so a failed save can never be reported as a
// success — an unchecked fetch() resolves happily on a 500.
async function postJSON(url, data) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch (err) {
    throw new Error('could not reach the admin server (is it still running?)');
  }
  if (!res.ok) throw new Error('server returned HTTP ' + res.status);
  // Every save the editor makes lands here, which makes it the one place that
  // knows the working tree just moved — so the Publish button's count follows
  // along instead of going stale until the next focus.
  schedulePublishRefresh();
  return res;
}

// git status per keystroke-ish save would be wasteful; one call after the
// burst settles is plenty.
let publishRefreshTimer = null;
function schedulePublishRefresh() {
  clearTimeout(publishRefreshTimer);
  publishRefreshTimer = setTimeout(() => refreshPublishState(), 400);
}

const ALBUM_STATUS_IDS = ['album-save-status', 'album-save-status-bottom'];

// Leave the message on screen rather than flashing it away — a lost edit is
// worth interrupting for.
function reportSaveError(statusIds, err) {
  console.error('Save failed:', err);
  let shown = 0;
  for (const id of [].concat(statusIds)) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Cancel any pending fade left over from an earlier "Saved!" — an error
    // must not disappear on a timer the success path started.
    clearTimeout(el._hideTimer);
    el.textContent = 'Not saved — ' + err.message;
    el.classList.add('error', 'show');
    shown++;
  }
  // A failure the user can't see is the bug this function exists to prevent.
  if (!shown) console.warn('reportSaveError: no status element for', statusIds);
}

// ── Generic drag-and-drop for .list-item lists ─────────────────────────────
function bindDrag(el, container, onChange) {
  container._onReorder = onChange;
  ensureDragContainer(container);

  el.addEventListener('dragstart', e => {
    dragSrc = el;
    setTimeout(() => el.classList.add('dragging'), 0);
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    if (container._dropLine) container._dropLine.style.display = 'none';
    dragSrc = null;
  });
}

// Sets up a shared horizontal drop-line indicator on the container (bound
// once), matching the interaction used for reordering albums in the sidebar —
// shows exactly where the dragged item will land, instead of highlighting
// whichever item it would swap with.
function ensureDragContainer(container) {
  if (container._dragReady) return;
  container._dragReady = true;
  container.style.position = 'relative';

  const dropLine = document.createElement('div');
  dropLine.className = 'drop-line-h';
  dropLine.style.display = 'none';
  container.appendChild(dropLine);
  container._dropLine = dropLine;

  container.addEventListener('dragover', e => {
    const item = e.target.closest('.list-item');
    if (!item || item === dragSrc || item.parentElement !== container) return;
    e.preventDefault();
    const cr = container.getBoundingClientRect();
    const ir = item.getBoundingClientRect();
    const before = e.clientY < ir.top + ir.height / 2;
    dropLine.style.top = ((before ? ir.top : ir.bottom) - cr.top - 1) + 'px';
    dropLine.style.display = '';
  });

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) dropLine.style.display = 'none';
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    dropLine.style.display = 'none';
    if (!dragSrc) return;
    const item = e.target.closest('.list-item');
    if (!item || item === dragSrc || item.parentElement !== container) return;
    const ir = item.getBoundingClientRect();
    const before = e.clientY < ir.top + ir.height / 2;
    container.insertBefore(dragSrc, before ? item : item.nextSibling);
    container._onReorder?.();
  });
}

// ── Album editor ───────────────────────────────────────────────────────────
async function selectAlbum(slug, hist = 'push') {
  await flushAutosave();
  await homeAutosave.flush();
  await aboutAutosave.flush();
  await socialsAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = albums.find(a => a.slug === slug);
  currentView  = null;
  if (!currentAlbum) return;
  syncUrl(hist, 'album', slug);
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

// Render the shared 2-column plan into the preview's markup. The packing
// decisions come from planMasonry(), the same function the live grid uses.
function layoutMasonryPreview(container, entries) {
  container.innerHTML = '';

  for (const entry of planMasonry(entries, 2)) {
    if (entry.type === 'panorama') {
      container.appendChild(entry.item.el);   // full-width, outside the columns
      continue;
    }
    const row = document.createElement('div');
    row.className = 'preview-row';
    for (const column of entry.columns) {
      const col = document.createElement('div');
      col.className = 'preview-col';
      column.forEach(({ el }) => col.appendChild(el));
      row.appendChild(col);
    }
    container.appendChild(row);
  }
}

// Setting the cover is reachable from both the order strip and the masonry
// preview, so it lives here: update the album, move the badges, and let
// autosave persist it.
function setCover(file) {
  if (!currentAlbum || currentAlbum.info.cover === file) return;
  currentAlbum.info.cover = file;
  refreshCoverBadges();
  autosaveAlbum();
}

// Move the Cover badge in place rather than re-rendering the two grids. A full
// re-render empties the preview first, and with the tall preview momentarily
// gone the page shrinks and the browser clamps the scroll position to the top —
// so double-clicking a photo would jump you back up to the order strip. Nothing
// but the badge actually changes here, so nothing else needs rebuilding.
function refreshCoverBadges() {
  const cover = effectiveCover(currentAlbum.info, currentAlbum.photos);

  document.querySelectorAll('#order-strip .strip-item').forEach(el => {
    const isCover = el.dataset.file === cover;
    el.classList.toggle('cover-selected', isCover);
    el.querySelector('.cover-badge')?.remove();
    if (isCover) {
      const badge = document.createElement('span');
      badge.className = 'cover-badge';
      badge.textContent = 'Cover';
      el.appendChild(badge);
    }
  });

  document.querySelectorAll('#masonry-preview .preview-item').forEach(el => {
    const isCover = el.dataset.file === cover;
    el.querySelector('.preview-cover-badge')?.remove();
    el.title = isCover ? 'Album cover' : 'Double-click to set as cover';
    if (isCover) {
      const badge = document.createElement('span');
      badge.className = 'preview-cover-badge';
      badge.textContent = 'Cover';
      el.appendChild(badge);
    }
  });

  // The mini panel renders its own elements and hides the badge in CSS, so the
  // cover moving needs nothing done to it.
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
      setCover(f);
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

  function makeItem(f, interactive) {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.dataset.file = f;

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

    // Same gesture as the order strip above — set the cover from whichever grid
    // you happen to be looking at. The mini panel is a thumbnail of the page,
    // not a second place to edit it, so its copies get neither.
    if (interactive) {
      item.title = f === cover ? 'Album cover' : 'Double-click to set as cover';
      item.addEventListener('dblclick', () => setCover(f));
    }

    return item;
  }

  const entries = interactive => photos.map(f => ({
    el: makeItem(f, interactive),
    aspect: aspectFromRatio(aspectCache[slug + '/' + f] ?? 1.33),
  }));

  layoutMasonryPreview(document.getElementById('masonry-preview'), entries(true));
  // The mini panel gets its own elements rather than a copy of the preview's
  // markup: innerHTML serializes attributes only, so a copy would arrive
  // without the onerror fallback each <img> needs when a photo has no
  // derivative yet — broken-image squares until something re-copied the markup
  // after the originals had already failed over.
  layoutMasonryPreview(document.getElementById('mini-preview-grid'), entries(false));
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
  await postJSON(API + '/albums/' + encodeURIComponent(currentAlbum.slug), info);
  currentAlbum.info = info;
  return info;
}

document.querySelectorAll('.album-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  if (!currentAlbum) return;
  try {
    await saveAlbumInfo();
  } catch (err) {
    reportSaveError(ALBUM_STATUS_IDS, err);
    return;
  }
  flashSaved('album-save-status');
  flashSaved('album-save-status-bottom');
}));

document.getElementById('album-back-btn').addEventListener('click', () => selectHome());

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

  await fetch(API + '/albums/' + encodeURIComponent(slug), { method: 'DELETE' });

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
  try {
    await saveAlbumInfo();
  } catch (err) {
    // Leave autosavePending set so the next edit (or an explicit Save) retries
    // instead of silently dropping the change — and never claim "Saved!".
    reportSaveError(ALBUM_STATUS_IDS, err);
    return;
  }
  autosavePending = false;
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
    try {
      await saveFn();
    } catch (err) {
      // Stay pending so the change is retried rather than quietly dropped.
      reportSaveError(statusIds, err);
      return;
    }
    pending = false;
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
async function selectHome(hist = 'push') {
  await flushAutosave();
  await aboutAutosave.flush();
  await socialsAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = null;
  currentView  = 'home';
  syncUrl(hist, 'home');
  renderSidebar();
  showEditor('home-editor');
  document.getElementById('home-name').value    = aboutData.name    ?? '';
  document.getElementById('home-tagline').value = aboutData.tagline ?? '';
  document.getElementById('home-save-status').classList.remove('show');
  document.getElementById('home-save-status-top').classList.remove('show');
  updateHomeEmptyState();
  renderAlbumSortStrip();
  renderHomeMasonryPreview();
}

function updateHomeEmptyState() {
  const empty = albums.length === 0;
  document.getElementById('home-empty-prompt').classList.toggle('visible', empty);
  document.getElementById('home-albums-section').style.display = empty ? 'none' : '';
}

// Grid of every album's cover, draggable to reorder — same interaction as the
// photo order strip (drop-line shows exactly where the album will land).
function renderAlbumSortStrip() {
  if (window._albumStripCtrl) window._albumStripCtrl.abort();
  window._albumStripCtrl = new AbortController();
  const sig = window._albumStripCtrl.signal;

  const strip = document.getElementById('album-sort-strip');
  strip.innerHTML = '';

  const dropLine = document.createElement('div');
  dropLine.className = 'drop-line-v';
  dropLine.style.display = 'none';

  albums.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'strip-item';
    item.draggable = true;
    item.dataset.slug = a.slug;

    const cover = a.photos.length ? effectiveCover(a.info, a.photos) : null;
    const img = document.createElement('img');
    if (cover) {
      img.src = thumbUrl(a.slug, cover, 480);
      img.onerror = () => { img.onerror = null; img.src = photoUrl(a.slug, cover); };
    }
    item.appendChild(img);

    const num = document.createElement('span');
    num.className = 'strip-num';
    num.textContent = i + 1;
    item.appendChild(num);

    const badge = document.createElement('span');
    badge.className = 'cover-badge';
    badge.textContent = albumDisplayName(a);
    item.appendChild(badge);

    item.addEventListener('dblclick', () => { if (!dragSrc) selectAlbum(a.slug); });

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
    saveAlbumOrder([...strip.querySelectorAll('.strip-item')].map(el => el.dataset.slug));
  }, { signal: sig });
}

// Mirrors src/pages/index.astro's masonry grid — same layout algorithm and
// the same title-overlay treatment on each tile — so this doubles as an
// accurate homepage preview.
// Mirrors index.astro's forced, evenly-cropped grid (not the true masonry used
// on album pages) — with just a handful of albums, uneven cover aspect ratios
// read as gaps rather than intentional variety, so every tile is the same
// fixed 4:3 box with the cover image cropped to fit via object-fit: cover.
function renderHomeMasonryPreview() {
  const eligible = albums.filter(a => a.photos.length > 0);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const container = document.getElementById('home-masonry-preview');
  container.innerHTML = '';

  eligible.forEach(a => {
    const cover = effectiveCover(a.info, a.photos);
    const item = document.createElement('div');
    item.className = 'home-preview-item';

    const img = document.createElement('img');
    img.src = thumbUrl(a.slug, cover, 960);
    img.onerror = () => { img.onerror = null; img.src = photoUrl(a.slug, cover); };
    item.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'home-preview-overlay';

    const title = document.createElement('p');
    title.className = 'home-preview-title';
    title.textContent = albumDisplayName(a);
    overlay.appendChild(title);

    const dateParts = [a.info.month ? MONTHS[a.info.month - 1] : null, a.info.year ?? null].filter(Boolean);
    if (dateParts.length) {
      const date = document.createElement('p');
      date.className = 'home-preview-date';
      date.textContent = dateParts.join(' · ');
      overlay.appendChild(date);
    }

    item.appendChild(overlay);

    item.title = 'Edit ' + albumDisplayName(a);
    item.addEventListener('click', () => selectAlbum(a.slug));

    container.appendChild(item);
  });
}

async function saveHomeData() {
  aboutData = {
    ...aboutData,
    name:    document.getElementById('home-name').value.trim(),
    tagline: document.getElementById('home-tagline').value.trim(),
  };
  await postJSON(API + '/about', aboutData);
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

async function selectAbout(hist = 'push') {
  await flushAutosave();
  await homeAutosave.flush();
  await projectsAutosave.flush();
  currentAlbum = null;
  currentView  = 'about';
  syncUrl(hist, 'about');
  renderSidebar();
  showEditor('about-editor');
  document.getElementById('about-heading').value = aboutData.heading ?? '';
  const bioList = document.getElementById('bio-list');
  bioList.innerHTML = '';
  (aboutData.bio ?? []).forEach(p => bioList.appendChild(createParaItem(p)));
  const gearList = document.getElementById('gear-list');
  gearList.innerHTML = '';
  (aboutData.gear ?? []).forEach(g => gearList.appendChild(createGearItem(g)));
  socialsData = await fetch(API + '/socials').then(r => r.json()).catch(() => []);
  const socialsList = document.getElementById('socials-list');
  socialsList.innerHTML = '';
  socialsData.forEach(s => socialsList.appendChild(createSocialItem(s)));
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
  await postJSON(API + '/about', aboutData);
}

const aboutAutosave = makeAutosave(saveAboutData, ['about-save-status', 'about-save-status-top']);

document.getElementById('about-heading').addEventListener('input', () => aboutAutosave.trigger());

document.querySelectorAll('.about-save-trigger').forEach(btn => btn.addEventListener('click', async () => {
  await saveAboutData();
  await saveSocialsData();
  flashSaved('about-save-status');
  flashSaved('about-save-status-top');
}));

// ── Socials editor ────────────────────────────────────────────────────────
// These labels get a real matching icon on the live site (see socialIcons in
// src/layouts/Layout.astro) — anything else still works, it just falls back
// to a generic link icon there, so any platform/website can be added.
const SOCIAL_LABELS = ['Instagram', 'LinkedIn', 'GitHub', 'Email', 'Twitter/X', 'YouTube', 'Facebook', 'Bluesky', 'Behance', '500px', 'Flickr', 'Vimeo'];

if (!document.getElementById('social-label-options')) {
  const datalist = document.createElement('datalist');
  datalist.id = 'social-label-options';
  SOCIAL_LABELS.forEach(label => {
    const opt = document.createElement('option');
    opt.value = label;
    datalist.appendChild(opt);
  });
  document.body.appendChild(datalist);
}

function createSocialItem(social) {
  const div = document.createElement('div');
  div.className = 'list-item';
  div.draggable = true;

  const handle = document.createElement('div');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const fields = document.createElement('div');
  fields.className = 'item-fields';

  const labelInput = document.createElement('input');
  labelInput.className = 'bare social-label';
  labelInput.setAttribute('list', 'social-label-options');
  labelInput.placeholder = 'Instagram, YouTube, My Blog...';
  labelInput.value = social?.label || '';

  const hrefInput = document.createElement('input');
  hrefInput.className = 'bare social-href';
  hrefInput.placeholder = 'https://... or mailto:you@example.com';
  hrefInput.value = social?.href || '';

  [labelInput, hrefInput].forEach(el =>
    el.addEventListener('input', () => socialsAutosave.trigger())
  );

  fields.append(labelInput, hrefInput);

  const btn = document.createElement('button');
  btn.className = 'remove-btn';
  btn.textContent = '×';
  btn.addEventListener('click', () => { div.remove(); socialsAutosave.trigger(); });

  div.append(handle, fields, btn);
  bindDrag(div, document.getElementById('socials-list'), () => socialsAutosave.trigger());
  return div;
}

document.getElementById('add-social').addEventListener('click', () => {
  document.getElementById('socials-list').appendChild(createSocialItem(null));
  socialsAutosave.trigger();
});

async function saveSocialsData() {
  socialsData = [...document.getElementById('socials-list').querySelectorAll('.list-item')].map(card => ({
    label: card.querySelector('.social-label').value.trim(),
    href:  card.querySelector('.social-href').value.trim(),
  })).filter(s => s.label && s.href);
  await postJSON(API + '/socials', socialsData);
}

const socialsAutosave = makeAutosave(saveSocialsData, ['about-save-status', 'about-save-status-top']);

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

async function selectProjects(hist = 'push') {
  await flushAutosave();
  await homeAutosave.flush();
  await aboutAutosave.flush();
  await socialsAutosave.flush();
  currentAlbum = null;
  currentView  = 'projects';
  syncUrl(hist, 'projects');
  renderSidebar();
  showEditor('projects-editor');
  const data = await fetch(API + '/projects').then(r => r.json());
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
  await postJSON(API + '/projects', projects);
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

  const slug = currentAlbum.slug;
  let done = 0;
  const showProgress = () =>
    setUploadStatus('Uploading ' + (done + 1) + ' of ' + images.length + '…');
  showProgress();

  try {
    // Upload a few at a time rather than all at once: each request streams a
    // full-res original, and firing forty in parallel just makes every one of
    // them slower (and used to hold all forty in the server's memory at once).
    const UPLOAD_CONCURRENCY = 4;
    const queue = [...images];
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const res = await fetch(
          API + \`/albums/\${encodeURIComponent(slug)}/upload?filename=\${encodeURIComponent(file.name)}\`,
          { method: 'POST', body: file },
        );
        if (!res.ok) throw new Error('upload of ' + file.name + ' failed (HTTP ' + res.status + ')');
        done++;
        if (done < images.length) showProgress();
      }
    }));

    setUploadStatus('Processing…');
    const res = await fetch(API + \`/albums/\${encodeURIComponent(slug)}/process\`, { method: 'POST' });
    if (!res.ok) throw new Error('image processing failed (HTTP ' + res.status + ')');
    const { photos, thumbs } = await res.json();

    const existing = new Set(currentAlbum.photos);
    const added = photos.filter(f => !existing.has(f));
    currentAlbum.photos = [...currentAlbum.photos, ...added];
    // The optimizer just wrote derivatives for these. Without taking the fresh
    // map, thumbUrl finds nothing for the new photos and the strip and preview
    // render them from full-size display files for the rest of the session.
    if (thumbs) currentAlbum.thumbs = thumbs;
    await saveAlbumInfo();

    renderOrderStrip();
    renderMasonryPreview();
    setUploadStatus('Added ' + added.length + ' image' + (added.length === 1 ? '' : 's'));
    flashSaved('album-save-status');
    flashSaved('album-save-status-bottom');
  } catch (err) {
    setUploadStatus(err.message || 'Upload failed — see console');
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
    await fetch(API + \`/albums/\${encodeURIComponent(currentAlbum.slug)}/photos/\${encodeURIComponent(f)}\`, { method: 'DELETE' });

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

// ── Publish ────────────────────────────────────────────────────────────────
// Commit and push the content the editor writes, so a session that started in
// the browser doesn't have to end in a terminal. The server stages only the
// content paths, and the panel lists every file before anything happens.
const publishBtn     = document.getElementById('publish-btn');
const publishPanel   = document.getElementById('publish-panel');
const publishMessage = document.getElementById('publish-message');
const publishStatus  = document.getElementById('publish-status');
let publishState = null;

// Turn a changed path into something worth reading in a commit subject.
function changeLabel(path) {
  const album = path.match(/^public\\/images\\/albums\\/([^/]+)\\//);
  if (album) {
    const a = albums.find(x => x.slug === album[1]);
    return a ? albumDisplayName(a) : album[1];
  }
  if (path.endsWith('about.json'))    return 'about';
  if (path.endsWith('projects.json')) return 'projects';
  if (path.endsWith('socials.json'))  return 'social links';
  if (path.endsWith('albums.json'))   return 'album order';
  return 'site content';
}

function defaultMessage(changes) {
  const labels = [...new Set(changes.map(c => changeLabel(c.path)))];
  // All new files under one album reads as an addition rather than an edit.
  const added = changes.every(c => c.status === '??');
  const verb  = added ? 'Add photos to ' : 'Update ';
  if (labels.length === 1) return verb + labels[0];
  if (labels.length === 2) return 'Update ' + labels[0] + ' and ' + labels[1];
  return 'Update site content';
}

async function refreshPublishState() {
  try {
    publishState = await fetch(API + '/git/status').then(r => {
      if (!r.ok) throw new Error('git status unavailable');
      return r.json();
    });
  } catch {
    // No git repo, or no git — publishing simply isn't on offer.
    publishState = null;
    publishBtn.style.display = 'none';
    return;
  }
  const n = publishState.changes.length;
  publishBtn.style.display = '';
  publishBtn.disabled = n === 0;
  publishBtn.innerHTML = n
    ? '<span id="publish-dot"></span>Publish ' + n + ' change' + (n === 1 ? '' : 's')
    : 'Nothing to publish';
}

function openPublishPanel() {
  if (!publishState || !publishState.changes.length) return;
  const { branch, changes } = publishState;

  // Name the destination in full. Whose repo this is matters most to someone
  // who cloned rather than forked: their push is going to fail, and it should
  // be obvious why before they press anything.
  const live = branch === 'main' || branch === 'master';
  const where = publishState.remoteUrl
    ? publishState.remoteUrl.replace(/^https:\\/\\/|\\.git$/g, '').replace(/^git@([^:]+):/, '$1/')
    : 'no remote configured';
  const notes = [];
  if (!publishState.identity) notes.push('git has no user.name / user.email set yet');
  if (!publishState.upstream) notes.push('first push — this sets the upstream');
  document.getElementById('publish-target').innerHTML =
    'Commit and push <strong>' + branch + '</strong> → ' + where +
    (live ? ' — this is the live site.' : '.') +
    (notes.length ? '<br>' + notes.join(' · ') : '');

  document.getElementById('publish-changes').innerHTML = changes
    .map(c => '<div>' + (c.status === '??' ? '+ ' : c.status + ' ') +
      c.path.replace('public/images/albums/', '').replace('src/data/', '') + '</div>')
    .join('');

  publishMessage.value = defaultMessage(changes);
  publishStatus.textContent = '';
  publishStatus.className = '';
  publishPanel.classList.add('open');
  publishMessage.focus();
  publishMessage.select();
}

function closePublishPanel() { publishPanel.classList.remove('open'); }

publishBtn.addEventListener('click', openPublishPanel);
document.getElementById('publish-cancel').addEventListener('click', closePublishPanel);
publishPanel.addEventListener('keydown', e => { if (e.key === 'Escape') closePublishPanel(); });

document.getElementById('publish-confirm').addEventListener('click', async () => {
  const confirmBtn = document.getElementById('publish-confirm');
  const message = publishMessage.value.trim();
  if (!message) { publishMessage.focus(); return; }

  // Autosaves are debounced, so a change made seconds ago may still be in
  // flight. Land them all before git looks at the working tree.
  await flushAutosave();
  await homeAutosave.flush();
  await aboutAutosave.flush();
  await socialsAutosave.flush();
  await projectsAutosave.flush();

  confirmBtn.disabled = true;
  publishStatus.className = '';
  publishStatus.textContent = 'Publishing…';
  try {
    const res  = await fetch(API + '/git/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'publish failed');
    publishStatus.className = 'ok';
    publishStatus.textContent = 'Pushed ' + data.sha + ' — ' + data.files + ' file' + (data.files === 1 ? '' : 's') + '.';
    setTimeout(closePublishPanel, 2500);
  } catch (err) {
    // Whatever git said, verbatim: an upstream that isn't set or a rejected
    // push needs the real message, not a tidied one.
    publishStatus.className = 'error';
    publishStatus.textContent = err.message;
  } finally {
    confirmBtn.disabled = false;
    refreshPublishState();
  }
});

// ── Theme ──────────────────────────────────────────────────────────────────
// Shared with the site via a cookie (see the pre-paint script up top): both run
// on localhost, and cookies — unlike localStorage — aren't scoped to the port,
// so toggling here also flips the dev site at :4321, and vice versa.
const themeBtn      = document.getElementById('theme-btn');
const iconMoon      = document.getElementById('icon-moon');
const iconSun       = document.getElementById('icon-sun');
const themeBtnLabel = document.getElementById('theme-btn-label');

function readThemePref() {
  const c = document.cookie.match(/(?:^|;\\s*)theme=(dark|light)/);
  return c ? c[1] : localStorage.getItem('admin-theme');
}

function applyTheme(dark, persist) {
  document.body.classList.toggle('dark', dark);
  iconMoon.style.display = dark ? 'none' : '';
  iconSun.style.display  = dark ? '' : 'none';
  themeBtnLabel.textContent = dark ? 'Light' : 'Dark';
  if (!persist) return;
  localStorage.setItem('admin-theme', dark ? 'dark' : 'light');
  document.cookie = 'theme=' + (dark ? 'dark' : 'light') + ';path=/;max-age=31536000;SameSite=Lax';
}

applyTheme(readThemePref() !== 'light', false);
themeBtn.addEventListener('click', () => applyTheme(!document.body.classList.contains('dark'), true));

// Cookie changes fire no event, so re-read on refocus — flip the theme on the
// site, come back to this tab, and it follows without a reload.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyTheme(readThemePref() !== 'light', false);
});

// ── New album ──────────────────────────────────────────────────────────────────
document.getElementById('add-album-btn').addEventListener('click', async () => {
  const input = prompt('Folder name for the new album (e.g. iceland-2026):');
  if (input === null) return;
  const slug = input.trim().split('/').pop();
  if (!slug) return;

  await flushAutosave();

  const res = await fetch(API + '/albums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    alert('Could not create album' + (error ? ': ' + error : '.'));
    return;
  }

  albums = await fetch(API + '/albums').then(r => r.json());
  await selectAlbum(slug);
});

load();
</script>
</body>
</html>`;
}

/**
 * The editor as a middleware. `base` is where it's mounted ('/admin' by
 * default) and is needed only by the page it serves: Connect strips the mount
 * prefix before the handler sees a request, so every route below matches
 * regardless of where it hangs.
 *
 * Synchronous on purpose, and so is the middleware it returns: the upload route
 * has to reach req.pipe() in the same tick or the first chunks are lost.
 */
export function createAdminHandler({ base = '' } = {}) {
  const SHELL = renderShell({ base });
  checkClientScripts(SHELL);

  // This handler's own subscribers, registered as the active one below.
  const reloadClients = new Set();
  let broadcastTimer = null;

  setActiveHandler({
    broadcastTimer: () => broadcastTimer,
    broadcast() {
      // Writes arrive in bursts — a drag reorders and autosaves, an upload lands
      // several files — and one reload at the end of the burst is enough.
      clearTimeout(broadcastTimer);
      broadcastTimer = setTimeout(() => {
        for (const res of reloadClients) {
          // Same reason the keepalive below guards: a subscriber's socket can be
          // gone by the time this fires.
          try { res.write('event: content\ndata: {}\n\n'); } catch { reloadClients.delete(res); }
        }
      }, 200);
    },
    // Loopback needs no keepalive, but this is how a connection dropped without
    // a FIN — a laptop that slept — gets noticed instead of accumulating.
    // unref'd so it never holds the dev server open on Ctrl-C.
    keepalive: setInterval(() => {
      for (const res of reloadClients) {
        try { res.write(': ping\n\n'); } catch { reloadClients.delete(res); }
      }
    }, 30_000).unref(),
  });

  return function admin(req, res, next) {
  // This rides on whatever `astro dev` bound, and `--host` binds every
  // interface. So the guarantee lives here rather than in a bind: this API
  // writes the repo and runs `git push`, and must answer nobody but this machine.
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('The admin panel only answers requests from this machine.\n');
    logErr('remote request', `refused ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    return;
  }

  const rawPath = new URL(req.url, 'http://localhost').pathname;
  // Decode so non-ASCII album slugs (e.g. "Hawaiʻi") match the folder on disk.
  let path;
  try { path = decodeURIComponent(rawPath); } catch { path = rawPath; }

  // A page on another origin can reach a localhost port through the browser, and
  // neither Vite's CORS defaults (any localhost port) nor Astro's Sec-Fetch rules
  // (same-site, and any navigation) stop a cross-origin form POST. This covers
  // the event stream too: the site subscribing to it is now same-origin, so
  // nothing legitimate needs an exemption, and without one no other site can
  // watch you save.
  if (path.startsWith('/api/') && !isSameOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{"error":"cross-origin request blocked"}');
    return;
  }

  // Shared layout rules, served straight from src/ so the admin preview and the
  // built site run the exact same code.
  if (path === '/layout.mjs') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(LAYOUT_FILE));
    } catch (err) { res.writeHead(500); res.end(); logErr('read layout.mjs', err); }
    return;
  }

  // Live-reload stream for the dev site. Held open until the page goes away.
  if (path === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }

  if (path.startsWith('/albums/')) {
    // `new URL()` normalises literal "../" segments, but percent-encoded ones
    // survive it and are decoded above — so resolve the final path and confirm
    // it really is inside ALBUMS_DIR before reading anything.
    const filePath = resolve(ALBUMS_DIR, path.slice('/albums/'.length));
    if (!filePath.startsWith(ALBUMS_DIR + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
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

  // Publishing. Both are async, so they answer themselves rather than going
  // through jsonGet/jsonPost, which reply the moment their handler returns.
  if (path === '/api/git/status' && req.method === 'GET') {
    gitStatus().then(data => jsonGet(res, data)).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      logErr('read git status', err);
    });
    return;
  }

  if (path === '/api/git/publish' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        // One line: a commit subject is what shows up in the log, and a stray
        // newline would silently turn the rest into the body.
        const subject = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!subject) throw new Error('a message is required');
        const result = await gitPublish(subject);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        logErr('publish', err);
      }
    });
    return;
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
      // Register it straight away. An album missing from albums.json still
      // renders — getAlbumSlugs sorts the unlisted ones last — so a new one
      // looked correctly placed while its position was really just a default,
      // and stayed unwritten until someone happened to drag something.
      saveAlbumOrder([...getAlbumOrder().filter(s => s !== slug), slug]);
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
  if (albumM && req.method === 'POST') {
    const slug = safeSlug(albumM[1]);
    if (!slug) { res.writeHead(400); return res.end('{"error":"invalid slug"}'); }
    return jsonPost(req, res, d => saveInfo(slug, d));
  }
  if (albumM && req.method === 'DELETE') {
    const slug = safeSlug(albumM[1]);
    if (!slug) { res.writeHead(400); return res.end('{"error":"invalid slug"}'); }
    try {
      rmSync(join(ALBUMS_DIR, slug), { recursive: true, force: true });
      try {
        const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        Object.keys(cache).forEach(k => {
          if (k === slug || k.startsWith(slug + '/') || k.startsWith('resized/' + slug + '/')) delete cache[k];
        });
        writeFileAtomic(CACHE_FILE, JSON.stringify(cache, null, 2));
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
    const slug = safeSlug(uploadM[1]);
    if (!slug) { res.writeHead(400); return res.end('{"error":"invalid slug"}'); }
    const filename = basename(new URL(req.url, 'http://localhost').searchParams.get('filename') ?? '');
    if (!IMAGE_RE.test(filename)) { res.writeHead(400); return res.end('{"error":"unsupported file type"}'); }
    const originalsDir = join(ALBUMS_DIR, slug, 'originals');
    try {
      if (!existsSync(originalsDir)) mkdirSync(originalsDir, { recursive: true });
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
      logErr(`create ${slug}/originals`, err);
      return;
    }
    // Stream to disk rather than collecting the body in memory — a batch of
    // full-res originals would otherwise sit in RAM all at once.
    const dest = join(originalsDir, filename);
    const out = createWriteStream(dest);
    const fail = err => {
      out.destroy();
      try { unlinkSync(dest); } catch {}   // don't leave a truncated file behind
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      logErr(`upload ${filename} to ${slug}`, err);
    };
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (res.headersSent) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      log(`Uploaded ${filename} to ${slug}/originals`);
    });
    req.pipe(out);
    return;
  }

  const deleteM = path.match(/^\/api\/albums\/([^/]+)\/photos\/([^/]+)$/);
  if (deleteM && req.method === 'DELETE') {
    const slug = safeSlug(deleteM[1]);
    if (!slug) { res.writeHead(400); return res.end('{"error":"invalid slug"}'); }
    const filename = basename(decodeURIComponent(deleteM[2]));
    const albumDir = join(ALBUMS_DIR, slug);
    const base = filename.replace(/\.[^.]+$/, '');
    try {
      // Derivative names carry a content hash, so they're found rather than
      // constructed — building `<base>-<width>w.webp` stopped matching anything
      // when the hash went in, which left every deleted photo's derivatives on
      // disk and still reachable by URL until the next optimizer run pruned them.
      const resizedDir = join(albumDir, 'resized');
      const derivatives = existsSync(resizedDir)
        ? readdirSync(resizedDir)
            .filter(f => { const m = DERIVATIVE_RE.exec(f); return m && m[1] === base; })
            .map(f => join(resizedDir, f))
        : [];

      [
        join(albumDir, DISPLAY_DIR, filename),
        join(albumDir, 'originals', filename),
        ...derivatives,
      ].forEach(p => { try { unlinkSync(p); } catch {} });

      try {
        const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
        delete cache[`${slug}/${filename}`];
        delete cache[`resized/${slug}/${filename}`];
        writeFileAtomic(CACHE_FILE, JSON.stringify(cache, null, 2));
      } catch {}

      contentChanged();
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
    const slug = safeSlug(processM[1]);
    if (!slug) { res.writeHead(400); return res.end('{"error":"invalid slug"}'); }
    log(`Running image optimizer (triggered by ${slug})…`);
    // Async, not execFileSync: Node is single-threaded, so a synchronous run
    // would freeze the whole admin — UI, thumbnails and all — until it finished.
    execFile('node', ['scripts/optimize-images.mjs'], { cwd: process.cwd() }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
        logErr(`optimize images for ${slug}`, err);
        return;
      }
      const displayDir = join(ALBUMS_DIR, slug, DISPLAY_DIR);
      const photos = existsSync(displayDir)
        ? readdirSync(displayDir).filter(f => IMAGE_RE.test(f) && !f.startsWith('.')).sort()
        : [];
      // The optimizer has just written derivatives for the new photos. Send
      // them back with the file list: without this the editor holds the thumbs
      // map it fetched at load, and every photo added this session renders from
      // its full-size display file until the page is reloaded.
      contentChanged();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, photos, thumbs: getThumbs(slug, photos) }));
    });
    return;
  }

  if (path === '/api/about' && req.method === 'GET')  return jsonGet(res, readJSON('about.json'));
  if (path === '/api/about' && req.method === 'POST') return jsonPost(req, res, d => writeJSON('about.json', d));

  if (path === '/api/projects' && req.method === 'GET')  return jsonGet(res, readJSON('projects.json'));
  if (path === '/api/projects' && req.method === 'POST') return jsonPost(req, res, d => writeJSON('projects.json', d));

  if (path === '/api/socials' && req.method === 'GET')  return jsonGet(res, readJSON('socials.json'));
  if (path === '/api/socials' && req.method === 'POST') return jsonPost(req, res, d => writeJSON('socials.json', d));

  // Everything else is a client route (/, /about, /projects, /album/<slug>) and
  // gets the app shell — except API paths, where falling through to HTML would
  // hand fetch() a 200 that then explodes on .json().
  if (path.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(SHELL);
  };
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Compile the scripts we're about to serve, without running them.
 *
 * The whole client lives inside a template literal, where a backslash has to be
 * doubled and a `${` escaped. Get that wrong and the browser is handed a module
 * it refuses to parse: the page renders nothing at all, the server reports a
 * healthy 200, and there is no clue anywhere but the browser console. (A `/\/$/`
 * written without doubling collapses to `//`, which comments out the rest of the
 * line — that is the whole failure.) One compile at startup turns a blank page
 * into a message in the terminal, naming the line.
 */
function checkClientScripts(html) {
  for (const [, attrs, source] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    // `import` is a syntax error outside a module, and vm has no module mode
    // without a flag. Blank the lines rather than dropping them, so the line
    // numbers a failure reports still match what the browser would see.
    const code = source.replace(/^\s*import .*$/gm, '');
    try {
      new Script(code, { filename: 'admin-client.js' });
    } catch (err) {
      const line = Number(err.stack?.match(/admin-client\.js:(\d+)/)?.[1]);
      const text = line ? source.split('\n')[line - 1]?.trim() : null;
      logErr(
        `admin client script${attrs.includes('module') ? ' (module)' : ''}`,
        `${err.message}${text ? `\n           line ${line}: ${text}` : ''}\n           ` +
        'The page will render blank until this is fixed — check the backslash ' +
        'and ${} escaping in the template literal.',
      );
    }
  }
}

// Loopback peers only. The IPv4-mapped form (::ffff:127.0.0.1) is what a
// dual-stack listener reports for an IPv4 client, so it counts too.
function isLocalRequest(req) {
  const addr = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  return addr === '::1' || addr.startsWith('127.');
}

// A matching Origin, or none at all (same-origin GETs and curl send none). Any
// state-changing method must bring one, so a cross-origin form POST — which does
// send Origin — can't pass as a request with none.
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET' || req.method === 'HEAD';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
