import { readFileSync } from 'fs';
import { mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const version = manifest.version;

execSync('esbuild content/content.js --bundle --outfile=dist/content.js --format=iife', { stdio: 'inherit' });
copyFileSync('content/ggdeals-scraper.js', 'dist/ggdeals-scraper.js');

// Package for Chrome Web Store
const PACKAGE = `steamtrades_booster_v${version}.zip`;
if (existsSync(PACKAGE)) rmSync(PACKAGE);
execSync(
  `zip -r ${PACKAGE} manifest.json background/ utils/ dist/content.js dist/ggdeals-scraper.js icons/ popup/ styles/`,
  { stdio: 'inherit' }
);
