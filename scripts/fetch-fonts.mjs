// Downloads the Barlow woff2 subsets into public/fonts/ and prints the
// @font-face rules to paste into src/styles/global.css.
//
// Self-hosting keeps fonts.googleapis.com and fonts.gstatic.com off the
// critical path: loading from Google means fetching a stylesheet from one host
// and parsing it before a font can even start downloading from another.
//
// Barlow is licensed under the SIL Open Font License, which permits this.
// Run only when the weights the site uses change.
import { writeFileSync, mkdirSync } from 'fs';

// 400 is the default body weight; 500/600/700/800 are used explicitly. 900 is
// never rendered anywhere, so it isn't fetched.
const WEIGHTS = [400, 500, 600, 700, 800];
const OUT_DIR = 'public/fonts';
// Google serves woff2 only to browsers that advertise support.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const css = await fetch(
  `https://fonts.googleapis.com/css2?family=Barlow:wght@${WEIGHTS.join(';')}&display=swap`,
  { headers: { 'User-Agent': UA } },
).then(r => r.text());

mkdirSync(OUT_DIR, { recursive: true });
const faces = [];

for (const block of css.split('@font-face').slice(1)) {
  const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
  const url    = block.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  const range  = block.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
  if (!weight || !url || !range) continue;

  // latin covers the site's text, including the ʻokina in "Hawaiʻi" (U+02BB).
  // latin-ext is kept for accented characters a fork might use; unicode-range
  // means it's only downloaded if such a character is actually rendered.
  const subset = range.includes('U+0000-00FF') ? 'latin'
               : range.includes('U+0100-02BA') ? 'latin-ext'
               : null;
  if (!subset) continue;

  const file = `barlow-${weight}-${subset}.woff2`;
  const buf = Buffer.from(await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.arrayBuffer()));
  writeFileSync(`${OUT_DIR}/${file}`, buf);
  console.log(`  ${(buf.length / 1024).toFixed(1).padStart(6)} KB  ${file}`);
  faces.push({ weight: Number(weight), subset, file, range });
}

faces.sort((a, b) => a.weight - b.weight || a.subset.localeCompare(b.subset));
console.log(`\n${faces.length} files written to ${OUT_DIR}/\n`);
console.log('@font-face rules for src/styles/global.css:\n');
for (const f of faces) {
  console.log(`@font-face {
  font-family: 'Barlow';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: swap;
  src: url('/fonts/${f.file}') format('woff2');
  unicode-range: ${f.range};
}`);
}
