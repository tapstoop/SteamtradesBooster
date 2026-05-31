// popup/settings.js

const REGIONS = ['au','be','br','ca','ch','de','dk','es','eu','fi','fr','gb','ie','it','nl','no','pl','se','us'];
const PLATFORMS = ['Steam','GOG','Epic','EA App','Ubisoft Connect','Battle.net'];
const KEYSHOPS = ['driffle','eneba','g2a','g2play','gamivo','kinguin'];

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(num) {
  return String(num).padStart(2, '0');
}

export function formatPopupDiagnosticDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildDiagnosticsPanelHtml({ expanded = false, log = '', generatedAt = null, loading = false, error = '' } = {}) {
  const hasLog = Boolean(log);
  const generatedText = generatedAt ? `Generated ${formatPopupDiagnosticDate(generatedAt)}` : 'Not generated yet';
  return `
    <div class="settings-section diagnostics-panel${expanded ? ' expanded' : ''}" id="error-log" data-expanded="${expanded ? 'true' : 'false'}">
      <div class="diagnostics-header">
        <div>
          <div class="settings-label">Diagnostics</div>
          <div class="diagnostics-meta" id="s-error-log-meta">${escapeHtml(generatedText)}</div>
        </div>
        <button class="btn-refresh diagnostics-toggle" id="s-toggle-log" type="button" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? 'Minimize' : 'Open'}</button>
      </div>
      <div class="diagnostics-body" ${expanded ? '' : 'hidden'}>
        <textarea class="settings-log" id="s-error-log" readonly>${escapeHtml(log || 'Click Generate to create a diagnostic snapshot.')}</textarea>
        <div class="diagnostics-error" id="s-error-log-error" ${error ? '' : 'hidden'}>${escapeHtml(error)}</div>
        <div class="diagnostics-actions">
          <button class="btn-primary settings-copy" id="s-generate-log" type="button" ${loading ? 'disabled' : ''}>${hasLog ? 'Refresh' : 'Generate'}</button>
          <button class="btn-primary settings-copy" id="s-copy-log" type="button" ${(!hasLog || loading) ? 'disabled' : ''}>Copy</button>
        </div>
      </div>
    </div>
  `;
}

function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, result => resolve(result?.[key])));
}

function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

export async function initSettings(container) {
  const focusErrorLog = new URLSearchParams(location.search).get('focus') === 'error-log';
  const [settings, savedDiagnosticsExpanded] = await Promise.all([
    msg('GET_SETTINGS'),
    storageGet('diagnosticsPanelExpanded'),
  ]);
  let diagnosticsExpanded = focusErrorLog || Boolean(savedDiagnosticsExpanded);
  let diagnosticsLog = '';
  let diagnosticsGeneratedAt = null;

  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-label">API</div>
      <input class="settings-input" id="s-apikey" type="password" placeholder="GG.deals API key" value="${escapeHtml(settings.apiKey ?? '')}">
      <input class="settings-input" id="s-steamid" type="text" placeholder="Steam profile URL or ID64" value="${escapeHtml(settings.steamId ?? '')}">
    </div>

    <div class="settings-section">
      <div class="settings-label">Preferences</div>
      <div class="preference-row">
        <label>Currency</label>
        <select id="s-currency" class="settings-select">
          <option value="EUR" ${settings.currency === 'EUR' ? 'selected' : ''}>EUR (€)</option>
          <option value="USD" ${settings.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
        </select>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Regions</div>
      <div class="chips" id="s-regions">
        ${REGIONS.map(r => `
          <span class="chip${settings.regions?.includes(r) ? ' active' : ''}" data-region="${r}">${r.toUpperCase()}</span>
        `).join('')}
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Platforms</div>
      <div class="chips" id="s-platforms">
        ${PLATFORMS.map(p => `
          <span class="chip${settings.platforms?.includes(p.toLowerCase().replace(/ /g,'')) ? ' active' : ''}" data-platform="${p.toLowerCase().replace(/ /g,'')}">${p}</span>
        `).join('')}
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Price Sources</div>
      <div class="toggle-row">
        <label>Official retail</label>
        <input type="checkbox" class="toggle" checked disabled>
      </div>
      <div class="toggle-row">
        <label>Grey market keyshops</label>
        <input type="checkbox" class="toggle" id="s-keyshops" ${settings.keyshopsEnabled ? 'checked' : ''}>
      </div>
      <div id="s-keyshop-detail" style="margin-top:6px;display:${settings.keyshopsEnabled ? 'block' : 'none'}">
        <div class="chips" id="s-keyshop-chips" style="margin-bottom:8px;">
          ${KEYSHOPS.map(k => `
            <span class="chip warn${settings.keyshops?.includes(k) ? ' active' : ''}" data-shop="${k}">${k}</span>
          `).join('')}
        </div>
        <div style="color:#555;font-size:9px;margin-bottom:6px;">Fee ranges (min% – max%) — estimated, shown at checkout</div>
        ${KEYSHOPS.map(k => `
          <div class="fee-row">
            <span style="width:60px">${k}</span>
            <input class="fee-input" data-shop="${k}" data-type="min" type="number" min="0" max="50" value="${settings.keyshopFees?.[k]?.min ?? 8}">
            <span>–</span>
            <input class="fee-input" data-shop="${k}" data-type="max" type="number" min="0" max="50" value="${settings.keyshopFees?.[k]?.max ?? 15}">
            <span>%</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Display</div>
      <div class="toggle-row">
        <label>Show sidebar on trader pages</label>
        <input type="checkbox" class="toggle" id="s-sidebar" ${settings.showSidebar ? 'checked' : ''}>
      </div>
      <div class="toggle-row">
        <label>Show full timestamp in badges</label>
        <input type="checkbox" class="toggle" id="s-fullts" ${settings.showFullTimestamp ? 'checked' : ''}>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Fetch Mode</div>
      <div class="toggle-row">
        <label>Selective (choose which games to fetch)</label>
        <input type="radio" name="fetch-mode" id="s-selective" class="toggle" value="selective" ${settings.selectiveFetch !== false ? 'checked' : ''}>
      </div>
      <div class="toggle-row">
        <label>Automatic (fetch all games on scroll)</label>
        <input type="radio" name="fetch-mode" id="s-automatic" class="toggle" value="automatic" ${settings.selectiveFetch === false ? 'checked' : ''}>
      </div>
      <div style="color:#856404;font-size:9px;margin-top:4px;padding:4px;background:#2a2214;border-radius:3px;">
        ⚠️ Automatic mode fetches prices for ALL games as you scroll, which can exhaust your API rate limits quickly.
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Thresholds</div>
      <div class="toggle-row">
        <label>DEAL badge threshold (%)</label>
        <input class="fee-input" id="s-dealthreshold" type="number" min="1" max="50" value="${settings.dealThresholdPct ?? 10}" style="width:50px">
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-label">Cache</div>
      <div class="cache-info">
        <div>Price data: Permanent (manual refresh only)</div>
        <div>Profile TTL: 30 minutes</div>
        <div>Name → App ID: Permanent</div>
      </div>
      <button class="btn-danger" id="s-clear">Clear all cached data</button>
    </div>

    <div class="settings-section bundle-support">
      <div class="settings-label">Bundle Support</div>
      <div class="bundle-support-info">
        <div class="bundle-support-warning">⚠️ Steam bundles cannot be searched by name</div>
        <div class="bundle-support-text">
          Steam bundles (collections, packs, anthologies, trilogies) are not indexed by Steam's search API.
        </div>
        <div class="bundle-support-steps">
          <div class="bundle-support-step-title">To add a bundle:</div>
          <ol class="bundle-support-list">
            <li>Find the bundle on the Steam store</li>
            <li>Copy the URL (e.g., <code>https://store.steampowered.com/bundle/16628/...</code>)</li>
            <li>Paste it in Bulk Import or Add Game</li>
          </ol>
        </div>
      </div>
    </div>

    ${buildDiagnosticsPanelHtml({ expanded: diagnosticsExpanded })}

    <hr class="settings-divider">
    <div class="settings-about">
      <div id="s-about-version">SteamTrades Booster</div>
      <div>
        <a href="https://github.com/tapstoop/SteamtradesBooster" target="_blank" rel="noreferrer">GitHub</a>
        ·
        <a href="https://github.com/tapstoop/SteamtradesBooster/releases" target="_blank" rel="noreferrer">Changelog</a>
      </div>
    </div>
  `;

  const manifest = chrome.runtime.getManifest?.();
  const aboutVersion = container.querySelector('#s-about-version');
  if (aboutVersion) aboutVersion.textContent = `SteamTrades Booster v${manifest?.version ?? 'unknown'}`;

  function renderDiagnosticsPanel({ loading = false, error = '' } = {}) {
    const panel = container.querySelector('#error-log');
    if (!panel) return;
    panel.outerHTML = buildDiagnosticsPanelHtml({
      expanded: diagnosticsExpanded,
      log: diagnosticsLog,
      generatedAt: diagnosticsGeneratedAt,
      loading,
      error,
    });
    bindDiagnosticsControls();
  }

  async function refreshDiagnosticLog() {
    renderDiagnosticsPanel({ loading: true });
    const response = await msg('GET_DIAGNOSTIC_LOG');
    if (response?.error) throw new Error(response.error);
    diagnosticsLog = response?.log ?? 'No diagnostics available.';
    diagnosticsGeneratedAt = Date.now();
    renderDiagnosticsPanel();
  }

  function bindDiagnosticsControls() {
    container.querySelector('#s-toggle-log')?.addEventListener('click', async e => {
      e.stopPropagation();
      diagnosticsExpanded = !diagnosticsExpanded;
      await storageSet({ diagnosticsPanelExpanded: diagnosticsExpanded });
      renderDiagnosticsPanel();
    });

    container.querySelector('#s-generate-log')?.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await refreshDiagnosticLog();
      } catch (err) {
        renderDiagnosticsPanel({ error: err?.message ?? 'Failed to generate diagnostics.' });
      }
    });

    container.querySelector('#s-copy-log')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (!diagnosticsLog) return;
      await navigator.clipboard.writeText(diagnosticsLog);
      e.target.textContent = 'Copied';
      setTimeout(() => {
        const copy = container.querySelector('#s-copy-log');
        if (copy) copy.textContent = 'Copy';
      }, 1500);
    });
  }

  bindDiagnosticsControls();

  if (focusErrorLog) {
    refreshDiagnosticLog().catch(err => {
      renderDiagnosticsPanel({ error: err?.message ?? 'Failed to generate diagnostics.' });
    }).finally(() => {
      const panel = container.querySelector('#error-log');
      panel?.scrollIntoView({ block: 'start' });
      panel?.classList.add('settings-highlight');
      setTimeout(() => panel?.classList.remove('settings-highlight'), 3000);
    });
  }

  // ── Currency change ────────────────────────────────────────────────────────
  container.querySelector('#s-currency').addEventListener('change', async () => {
    settings.currency = container.querySelector('#s-currency').value;
    await save();
  });

  // ── Other event wiring ────────────────────────────────────────────────────

  container.querySelector('#s-regions').addEventListener('click', e => {
    if (e.target.classList.contains('chip')) e.target.classList.toggle('active');
  });
  container.querySelector('#s-platforms').addEventListener('click', e => {
    if (e.target.classList.contains('chip')) e.target.classList.toggle('active');
  });
  container.querySelector('#s-keyshops').addEventListener('change', e => {
    container.querySelector('#s-keyshop-detail').style.display = e.target.checked ? 'block' : 'none';
  });
  container.querySelector('#s-keyshop-chips').addEventListener('click', e => {
    if (e.target.classList.contains('chip')) e.target.classList.toggle('active');
  });
  container.querySelector('#s-clear').addEventListener('click', async () => {
    await msg('CLEAR_CACHE');
    alert('Cache cleared.');
  });

  container.addEventListener('change', save);
  container.addEventListener('input', debounce(save, 600));

  // ── Save ─────────────────────────────────────────────────────────────────

  async function save() {
    const regions = [...container.querySelectorAll('#s-regions .chip.active')].map(c => c.dataset.region);
    const platforms = [...container.querySelectorAll('#s-platforms .chip.active')].map(c => c.dataset.platform);
    const keyshops = [...container.querySelectorAll('#s-keyshop-chips .chip.active')].map(c => c.dataset.shop);

    const keyshopFees = { ...settings.keyshopFees };
    container.querySelectorAll('.fee-input[data-shop]').forEach(input => {
      const shop = input.dataset.shop;
      const type = input.dataset.type;
      if (!keyshopFees[shop]) keyshopFees[shop] = { min: 8, max: 15 };
      keyshopFees[shop][type] = parseInt(input.value) || 0;
    });

    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
      apiKey: container.querySelector('#s-apikey').value.trim(),
      steamId: container.querySelector('#s-steamid').value.trim(),
      currency: container.querySelector('#s-currency').value,
      regions,
      platforms,
      keyshopsEnabled: container.querySelector('#s-keyshops').checked,
      keyshops,
      keyshopFees,
      showSidebar: container.querySelector('#s-sidebar').checked,
      showFullTimestamp: container.querySelector('#s-fullts').checked,
      selectiveFetch: container.querySelector('#s-selective').checked,
      dealThresholdPct: parseInt(container.querySelector('#s-dealthreshold').value) || 10,
    }});
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
