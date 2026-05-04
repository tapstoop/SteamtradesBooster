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

export async function initSettings(container) {
  const settings = await msg('GET_SETTINGS');

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
  `;

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
