const VALID_TARGETS = new Set(['chrome', 'firefox']);

const FIREFOX_GECKO_SETTINGS = {
  id: 'steamtrades-booster@example.com',
  strict_min_version: '142.0',
  data_collection_permissions: {
    required: ['none']
  }
};

export function getBuildTarget(rawTarget = 'chrome') {
  const target = rawTarget || 'chrome';
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown build target "${target}". Expected one of: chrome, firefox`);
  }
  return target;
}

export function getOutputNames(target, version) {
  return {
    outDir: `steamtrades_booster_${target}_v${version}`,
    packageName: `steamtrades_booster_${target}_v${version}.zip`
  };
}

function createBackground(target) {
  if (target === 'firefox') {
    return {
      scripts: ['dist/service-worker.js']
    };
  }

  return {
    service_worker: 'dist/service-worker.js'
  };
}

export function createPackagedManifest(manifest, { target, includeIcons }) {
  const packagedManifest = {
    manifest_version: manifest.manifest_version,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    permissions: manifest.permissions,
    host_permissions: manifest.host_permissions,
    background: createBackground(target),
    content_scripts: manifest.content_scripts,
    action: manifest.action
  };

  if (includeIcons && manifest.icons) {
    packagedManifest.icons = manifest.icons;
  }

  if (target === 'firefox') {
    packagedManifest.browser_specific_settings = {
      gecko: FIREFOX_GECKO_SETTINGS
    };
  }

  return packagedManifest;
}
