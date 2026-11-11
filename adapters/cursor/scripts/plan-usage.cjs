'use strict';

/**
 * Fetch Cursor account plan usage (Auto / API pools) using the local IDE session.
 * Reads encrypted cursorAuth/accessToken from state.vscdb (Windows DPAPI + AES-GCM),
 * then POSTs dashboard get-current-period-usage. JWT never lands in answer HTML.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DATA_DIR, ensureDir, readJson, writeJson } = require('./lib.cjs');

const CACHE_PATH = path.join(DATA_DIR, 'plan-usage.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.token');
const DECRYPT_PY = path.join(__dirname, 'decrypt_cursor_token.py');
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const pad = '='.repeat((4 - (parts[1].length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(parts[1] + pad, 'base64url').toString('utf8'));
  } catch {
    try {
      return JSON.parse(Buffer.from(parts[1] + pad, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

function pythonRunners() {
  const local = process.env.LOCALAPPDATA || '';
  const home = os.homedir();
  const binaries = [
    process.env.TOKEN_LENS_PYTHON,
    path.join(local, 'Programs', 'Python', 'Launcher', 'py.exe'),
    path.join(local, 'Python', 'bin', 'python3.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Launcher', 'py.exe'),
    'py',
    'python3',
    'python',
  ].filter(Boolean);

  const runners = [];
  for (const bin of binaries) {
    const base = path.basename(bin).toLowerCase();
    if (base === 'py.exe' || base === 'py') {
      runners.push([bin, ['-3']]);
    } else {
      runners.push([bin, []]);
    }
  }
  return runners;
}

function runPy(scriptArgs) {
  let last = { ok: false, stdout: '', stderr: 'python not found', status: -1 };
  for (const [cmd, prefix] of pythonRunners()) {
    const run = spawnSync(cmd, [...prefix, ...scriptArgs], {
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
      env: { ...process.env },
    });
    const stdout = (run.stdout || '').trim();
    const stderr = (run.stderr || '').trim();
    if (run.status === 0 && stdout) {
      return { ok: true, stdout, stderr, cmd };
    }
    if (stdout || stderr) {
      last = { ok: false, stdout, stderr, status: run.status, cmd };
    }
  }
  return last;
}

function friendlyUsageError(raw) {
  const text = String(raw || '');
  if (/403|cloudflare|attention required|astro-cid/i.test(text)) {
    return 'Лимиты временно недоступны (сессия/сеть). Откройте Usage в личном кабинете.';
  }
  if (/python not found/i.test(text)) {
    return 'Лимиты недоступны: не найден Python для чтения сессии Cursor.';
  }
  if (/<!DOCTYPE html|/i.test(text) || text.includes('<html')) {
    return 'Лимиты временно недоступны. Откройте Usage в личном кабинете.';
  }
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 160) || 'Лимиты временно недоступны.';
}

function keepStaleOrError(cached, error) {
  const message = friendlyUsageError(error);
  if (cached && cached.plan) {
    const stale = {
      ...cached,
      at: cached.at,
      cached: true,
      stale: true,
      warning: message,
    };
    writeJson(CACHE_PATH, stale);
    return stale;
  }
  const miss = {
    at: new Date().toISOString(),
    error: message,
    plan: null,
  };
  writeJson(CACHE_PATH, miss);
  return miss;
}

function readAccessToken() {
  const override = process.env.CURSOR_SESSION_TOKEN || process.env.TOKEN_LENS_SESSION_TOKEN;
  if (override && override.trim()) return override.trim();
  if (fs.existsSync(SESSION_FILE)) {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (raw) return raw;
  }

  // Encrypted cursor-safe-storage:v1 → JWT via Python (Windows DPAPI).
  if (fs.existsSync(DECRYPT_PY)) {
    const run = runPy([DECRYPT_PY, '--jwt']);
    if (run.ok) {
      const line = run.stdout.split(/\r?\n/).filter(Boolean).pop();
      if (line && line.split('.').length >= 3) return line;
      try {
        const parsed = JSON.parse(run.stdout);
        if (parsed && parsed.jwt) return parsed.jwt;
      } catch {
        if (line && line.includes('.')) return line;
      }
    }
  }
  return null;
}

function buildCookie(token) {
  if (token.includes('::') || token.includes('%3A%3A')) return token;
  const payload = decodeJwtPayload(token);
  const sub = payload && payload.sub ? String(payload.sub) : '';
  if (!sub) return null;
  return `${encodeURIComponent(sub)}%3A%3A${encodeURIComponent(token)}`;
}

async function postJson(url, cookie, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: `WorkosCursorSessionToken=${cookie}`,
      Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function asDate(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e11) return new Date(n).toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function normalizePlanUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  let plan = raw.planUsage || null;
  let membership = raw.membershipType || raw.plan || null;
  let cycleStart = raw.billingCycleStart || null;
  let cycleEnd = raw.billingCycleEnd || null;

  if (!plan && raw.individualUsage && raw.individualUsage.plan) {
    const p = raw.individualUsage.plan;
    plan = {
      ...p,
      totalSpend: p.used,
      includedSpend: p.used,
      autoPercentUsed: p.autoPercentUsed,
      apiPercentUsed: p.apiPercentUsed,
      totalPercentUsed: p.totalPercentUsed,
    };
    membership = raw.membershipType || membership;
    cycleStart = raw.billingCycleStart || cycleStart;
    cycleEnd = raw.billingCycleEnd || cycleEnd;
  }

  if (!plan) return null;

  const autoPct = Number(plan.autoPercentUsed);
  const apiPct = Number(plan.apiPercentUsed);
  const totalPct = Number(plan.totalPercentUsed);
  const limit = plan.limit != null ? Number(plan.limit) : null;
  const used =
    plan.includedSpend != null
      ? Number(plan.includedSpend)
      : plan.totalSpend != null
        ? Number(plan.totalSpend)
        : plan.used != null
          ? Number(plan.used)
          : null;
  const remaining =
    plan.remaining != null
      ? Number(plan.remaining)
      : limit != null && used != null
        ? Math.max(0, limit - used)
        : null;

  return {
    at: new Date().toISOString(),
    membership: membership || null,
    billing_cycle_start: asDate(cycleStart),
    billing_cycle_end: asDate(cycleEnd),
    display_message: raw.displayMessage || null,
    auto_message: raw.autoModelSelectedDisplayMessage || null,
    api_message: raw.namedModelSelectedDisplayMessage || null,
    plan: {
      used,
      limit,
      remaining,
      bonus_spend: plan.bonusSpend != null ? Number(plan.bonusSpend) : null,
      // Cursor returns a boolean, not a remaining amount / bonus limit.
      remaining_bonus:
        typeof plan.remainingBonus === 'boolean' ? plan.remainingBonus : null,
      bonus_tooltip: raw.planUsage && raw.planUsage.bonusTooltip
        ? String(raw.planUsage.bonusTooltip)
        : plan.bonusTooltip
          ? String(plan.bonusTooltip)
          : null,
      auto_percent_used: Number.isFinite(autoPct) ? autoPct : null,
      api_percent_used: Number.isFinite(apiPct) ? apiPct : null,
      total_percent_used: Number.isFinite(totalPct) ? totalPct : null,
    },
    source: 'cursor.com/api/dashboard/get-current-period-usage',
  };
}

function cacheFresh(cache, ttlMs) {
  if (!cache || !cache.plan) return false;
  const at = Date.parse(cache.at || 0);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < ttlMs;
}

async function fetchPlanUsage({ force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  ensureDir();
  const cached = readJson(CACHE_PATH, null);
  if (!force && cacheFresh(cached, ttlMs) && cached.plan) {
    return { ...cached, cached: true };
  }

  // Node fetch to cursor.com often gets Cloudflare 403 HTML. Use Python only.
  if (!fs.existsSync(DECRYPT_PY)) {
    return keepStaleOrError(cached, 'Нет decrypt_cursor_token.py');
  }

  const run = runPy([DECRYPT_PY, '--fetch']);
  if (!run.ok) {
    let detail = run.stderr || run.stdout || 'python fetch failed';
    try {
      const parsed = JSON.parse(run.stdout || '{}');
      if (parsed && parsed.error) detail = parsed.error;
    } catch {
      /* keep detail */
    }
    return keepStaleOrError(cached, detail);
  }

  try {
    const raw = JSON.parse(run.stdout);
    if (raw && raw.error) return keepStaleOrError(cached, raw.error);
    const normalized = normalizePlanUsage(raw);
    if (!normalized) return keepStaleOrError(cached, 'Неизвестный формат ответа usage API');
    writeJson(CACHE_PATH, normalized);
    return { ...normalized, cached: false };
  } catch (error) {
    return keepStaleOrError(cached, error && error.message ? error.message : error);
  }
}

function fetchPlanUsageSync(opts = {}) {
  const force = opts.force ? '--force' : '';
  const self = __filename;
  const run = spawnSync(process.execPath, [self, '--fetch', force].filter(Boolean), {
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
  if (run.status !== 0) {
    return readJson(CACHE_PATH, {
      at: new Date().toISOString(),
      error: (run.stderr || run.stdout || 'fetch failed').trim().slice(0, 300),
      plan: null,
    });
  }
  try {
    return JSON.parse((run.stdout || '').trim() || '{}');
  } catch {
    return readJson(CACHE_PATH, null);
  }
}

function helpTip(resetIso) {
  const lines = [
    'Auto% и API% — доли пулов Cursor Models / Other Models за период (как в Usage).',
    'Это проценты Usage, не минуты.',
    resetIso ? `Сброс периода: ${String(resetIso).slice(0, 10)}.` : '',
  ];
  return escapeLite(lines.filter(Boolean).join(' '));
}

function formatPlanUsageLine(planUsage) {
  if (!planUsage || !planUsage.plan) {
    if (planUsage && planUsage.error) return `Лимиты: ${friendlyUsageError(planUsage.error)}`;
    return 'Лимиты: нет данных';
  }
  const p = planUsage.plan;
  const bits = [];
  const auto = clampPct(p.auto_percent_used);
  const api = clampPct(p.api_percent_used);
  if (planUsage.membership) bits.push(String(planUsage.membership));
  if (auto != null) bits.push(`Auto ${auto.toFixed(0)}%`);
  if (api != null) bits.push(`API ${api.toFixed(0)}%`);
  const resetIso = planUsage.billing_cycle_end || null;
  if (resetIso) bits.push(`сброс ${String(resetIso).slice(0, 10)}`);
  return bits.length ? `Лимиты: ${bits.join(' · ')}` : 'Лимиты: нет данных';
}

function renderPlanBars(planUsage) {
  const lk = 'https://cursor.com/dashboard?tab=usage';
  if (!planUsage || !planUsage.plan) {
    const err = planUsage && planUsage.error
      ? escapeLite(friendlyUsageError(planUsage.error))
      : 'лимиты временно недоступны';
    return `<details class="plan">
      <summary><span class="plan-caret" aria-hidden="true"></span><span class="plan-title">Лимиты подписки</span><span class="plan-summary muted">${err}</span></summary>
      <div class="plan-body"><p class="plan-lk"><a href="${lk}" target="_blank" rel="noopener noreferrer">Usage в личном кабинете Cursor</a></p></div>
    </details>`;
  }
  const p = planUsage.plan;
  const auto = clampPct(p.auto_percent_used);
  const api = clampPct(p.api_percent_used);
  const total = clampPct(p.total_percent_used);
  const resetIso = planUsage.billing_cycle_end || null;
  const reset = resetIso ? `сброс ${escapeLite(String(resetIso).slice(0, 10))}` : '';
  const tip = helpTip(resetIso);

  const summaryBits = [];
  if (auto != null) {
    summaryBits.push(
      `<span class="plan-metric">Auto ${escapeLite(auto.toFixed(0))}%<button type="button" class="plan-help" title="${tip}" aria-label="Пояснение лимитов" onclick="event.preventDefault();event.stopPropagation();">?</button></span>`
    );
  }
  if (api != null) summaryBits.push(`API ${escapeLite(api.toFixed(0))}%`);
  if (reset) summaryBits.push(reset);

  return `
    <details class="plan">
      <summary>
        <span class="plan-caret" aria-hidden="true"></span>
        <span class="plan-title">Лимиты подписки</span>
        <span class="plan-summary">${summaryBits.join(' · ')}</span>
      </summary>
      <div class="plan-body">
        ${barRow('Auto + Composer', auto, '#68bdea')}
        ${barRow('API / premium', api, '#e4a17d')}
        ${barRow('Всего (blend)', total, '#a78bfa')}
        <p class="plan-lk"><a href="${lk}" target="_blank" rel="noopener noreferrer">Usage в личном кабинете Cursor</a></p>
      </div>
    </details>`;
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function escapeLite(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function barRow(label, pct, color) {
  if (pct == null) return '';
  const left = Math.max(0, 100 - pct);
  return `<div class="plan-row">
    <div class="plan-label"><span>${escapeLite(label)}</span><strong>${escapeLite(pct.toFixed(1))}%</strong></div>
    <div class="plan-track"><span style="width:${pct}%;background:${color}"></span></div>
    <div class="plan-sub muted">${escapeLite(pct.toFixed(1))}% · осталось ≈ ${escapeLite(left.toFixed(1))}%</div>
  </div>`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--fetch') || args.includes('--force') || args.length === 0) {
    const out = await fetchPlanUsage({ force: args.includes('--force') });
    process.stdout.write(JSON.stringify(out));
    return;
  }
  process.stdout.write(JSON.stringify(readJson(CACHE_PATH, { error: 'no cache', plan: null })));
}

module.exports = {
  CACHE_PATH,
  fetchPlanUsage,
  fetchPlanUsageSync,
  formatPlanUsageLine,
  renderPlanBars,
  readAccessToken,
};

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      at: new Date().toISOString(),
      error: String(error && error.message ? error.message : error),
      plan: null,
    };
    try {
      writeJson(CACHE_PATH, payload);
    } catch {
      /* ignore */
    }
    process.stdout.write(JSON.stringify(payload));
    process.exitCode = 1;
  });
}
