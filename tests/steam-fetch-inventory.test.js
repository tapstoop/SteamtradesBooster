import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const backgroundFiles = ['resolver.js', 'profile.js', 'service-worker.js'];

describe('Steam fetch inventory', () => {
  it('keeps direct Steam fetch calls inside the shared scheduler', () => {
    for (const file of backgroundFiles) {
      const source = readFileSync(new URL(`../background/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }

    const ggDealsSource = readFileSync(new URL('../background/ggdeals.js', import.meta.url), 'utf8');
    const subExpansion = ggDealsSource.slice(
      ggDealsSource.indexOf('export async function getSubApps'),
      ggDealsSource.indexOf('export async function getBundles'),
    );
    expect(subExpansion).toContain('steamFetch(');
    expect(subExpansion).not.toMatch(/\bfetch\s*\(/);
  });
});
