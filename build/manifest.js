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
  // Chrome requires dot-separated integers for directory naming too
  const cleanVersion = version.replace(/-.+$/, '');
  return {
    outDir: `steamtrades_booster_${target}_v${cleanVersion}`,
    packageName: `steamtrades_booster_${target}_v${cleanVersion}.zip`
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
  const action = { ...manifest.action };

  // Chrome requires strictly dot-separated integers for version (no pre-release tags).
  // Strip semver suffixes like "-alpha.1" → "0.1.4-alpha.1" becomes "0.1.4"
  const chromeVersion = manifest.version.replace(/-.+$/, '');

  const packagedManifest = {
    manifest_version: manifest.manifest_version,
    name: manifest.name,
    version: chromeVersion,
    description: manifest.description,
    permissions: manifest.permissions,
    host_permissions: manifest.host_permissions,
    content_security_policy: manifest.content_security_policy,
    background: createBackground(target),
    content_scripts: manifest.content_scripts,
    action
  };

  if (includeIcons) {
    if (manifest.icons) {
      packagedManifest.icons = manifest.icons;
    }
  } else {
    if ('icons' in manifest || (manifest.action && manifest.action.default_icon)) {
      delete packagedManifest.icons;
      delete packagedManifest.action.default_icon;
    }
  }

  if (target === 'firefox') {
    packagedManifest.browser_specific_settings = {
      gecko: FIREFOX_GECKO_SETTINGS
    };
  }

  return packagedManifest;
}
