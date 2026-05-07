import { mkdirSync, copyFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

mkdirSync('dist/background', { recursive: true });

execSync('esbuild content/content.js --bundle --outfile=dist/content.js --format=iife', { stdio: 'inherit' });

for (const file of readdirSync('background').filter(f => f.endsWith('.js'))) {
  copyFileSync(join('background', file), join('dist/background', file));
}

copyFileSync('content/ggdeals-scraper.js', 'dist/ggdeals-scraper.js');
