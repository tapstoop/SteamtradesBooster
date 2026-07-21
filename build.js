import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createPackagedManifest, getBuildTarget, getOutputNames } from './build/manifest.js';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const version = manifest.version;
const target = getBuildTarget(process.argv[2]);
const { outDir: OUTDIR, packageName: PACKAGE } = getOutputNames(target, version);
const esbuild = 'npx esbuild';
// Preflight checks
try {
  execSync(`${esbuild} --version`, { stdio: 'ignore' });
} catch {
  console.error('ERROR: esbuild is required. Run: npm install');
  process.exit(1);
}
for (const f of ['content/content.js', 'background/service-worker.js', 'popup/popup.js']) {
  if (!existsSync(f)) {
    console.error(`ERROR: Required source file missing: ${f}`);
    process.exit(1);
  }
}

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

// Bundle content script
execSync(`${esbuild} content/content.js --bundle --outfile=${OUTDIR}/dist/content.js --format=iife`, { stdio: 'inherit' });

// Bundle background service worker (eliminates module imports for Brave compatibility)
execSync(`${esbuild} background/service-worker.js --bundle --outfile=${OUTDIR}/dist/service-worker.js --format=iife`, { stdio: 'inherit' });

// Bundle popup script (eliminates module imports for Brave compatibility)
execSync(`${esbuild} popup/popup.js --bundle --outfile=${OUTDIR}/dist/popup.js --format=iife`, { stdio: 'inherit' });

// Bundle standalone content script
execSync(`${esbuild} content/ggdeals-scraper.js --bundle --outfile=${OUTDIR}/dist/ggdeals-scraper.js --format=iife`, { stdio: 'inherit' });

// Write packaged manifest (bundled version — no module type)
const includeIcons = existsSync('icons');
const packagedManifest = createPackagedManifest(manifest, { target, includeIcons });
writeFileSync(`${OUTDIR}/manifest.json`, JSON.stringify(packagedManifest, null, 2));

// Write packaged popup.html (no type="module" — bundled IIFE)
const popupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SteamTrades Price Tracker</title>
  <link rel="stylesheet" href="../styles/popup.css">
  <link rel="stylesheet" href="tradables.css">
</head>
<body>
  <div id="steam-tracker-alert-slot"></div>
  <div id="tabs">
    <button class="tab active" data-tab="deals">Wishlist</button>
    <button class="tab" data-tab="tradablesDetailed">Tradables detailed</button>
    <button class="tab" data-tab="tradables">Tradables</button>
    <button class="tab" data-tab="settings">⚙ Settings</button>
    <button id="pop-out-btn" class="tab" title="Open in new tab" style="flex:0; padding: 9px 8px;">↗</button>
  </div>
  <div id="tab-deals" class="tab-content active"></div>
  <div id="tab-tradablesDetailed" class="tab-content"></div>
  <div id="tab-tradables" class="tab-content"></div>
  <div id="tab-settings" class="tab-content"></div>
  <script src="../dist/popup.js"></script>
</body>
</html>`;
mkdirSync(`${OUTDIR}/popup`, { recursive: true });
writeFileSync(`${OUTDIR}/popup/popup.html`, popupHtml);

// Copy popup CSS
copyFileSync('popup/tradables.css', `${OUTDIR}/popup/tradables.css`);

// Copy styles
mkdirSync(`${OUTDIR}/styles`, { recursive: true });
copyFileSync('styles/content.css', `${OUTDIR}/styles/content.css`);
copyFileSync('styles/popup.css', `${OUTDIR}/styles/popup.css`);

// Copy icons if they exist
if (existsSync('icons')) {
  mkdirSync(`${OUTDIR}/icons`, { recursive: true });
  copyFileSync('icons/icon16.png', `${OUTDIR}/icons/icon16.png`);
  copyFileSync('icons/icon48.png', `${OUTDIR}/icons/icon48.png`);
  copyFileSync('icons/icon128.png', `${OUTDIR}/icons/icon128.png`);
}

// Package as ZIP
if (existsSync(PACKAGE)) rmSync(PACKAGE);
execSync(`cd ${OUTDIR} && zip -r ../${PACKAGE} .`, { stdio: 'inherit' });

console.log(`\n✓ Packaged ${PACKAGE} from ${OUTDIR}/`);
