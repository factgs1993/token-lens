'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

const DATA_DIR = path.join(os.homedir(), '.cursor', 'token-lens');
const STATUS_PATH = path.join(DATA_DIR, 'status.json');
const ACTIVE_PATH = path.join(DATA_DIR, 'active.json');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');
const LATEST_MD = path.join(DATA_DIR, 'latest.md');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const MARKER_PATH = path.join(DATA_DIR, 'extension-activated.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatNum(value) {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('ru-RU');
}

function shortId(id) {
  if (!id || typeof id !== 'string') return '—';
  return id.slice(0, 8);
}

function loadChat(conversationId) {
  if (!conversationId || !/^[a-zA-Z0-9_-]{1,100}$/.test(conversationId)) return null;
  return readJson(path.join(CHATS_DIR, `${conversationId}.json`), null);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function metricCard(label, value, hint) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint || '')}</small></div>`;
}

function renderHtml(state) {
  const index = state.index || [];
  const turns = (state.chat && state.chat.turns) || [];
  const turn = state.turn;
  const m = turn && turn.measured;
  const consumers = (turn && turn.consumers) || [];
  const cats = (turn && turn.categories) || {};
  const chatOptions = index
    .map((row) => {
      const selected = row.conversation_id === state.selectedChatId ? ' selected' : '';
      const label = `${shortId(row.conversation_id)} · ${row.turn_count || 0} ход. · Σ ${formatNum(row.chat_total)}`;
      return `<option value="${escapeHtml(row.conversation_id)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');

  const turnButtons = turns
    .map((row, i) => {
      const active = i === state.selectedTurnIndex ? ' active' : '';
      const total = row.measured ? formatNum(row.measured.total_tokens) : '—';
      const when = row.at ? new Date(row.at).toLocaleString('ru-RU') : '—';
      return `<button class="turn${active}" data-index="${i}"><span>#${i + 1}</span><strong>${escapeHtml(total)}</strong><small>${escapeHtml(when)}</small></button>`;
    })
    .reverse()
    .join('');

  const consumerRows = consumers.length
    ? consumers
        .map((row) => `<tr><td><code>${escapeHtml(row.name)}</code></td><td>${escapeHtml(formatNum(row.tokens))}</td></tr>`)
        .join('')
    : '<tr><td colspan="2">Нет оценки по инструментам за этот ход</td></tr>';

  const measuredBlock = m
    ? `<div class="metrics">
        ${metricCard('Вход', formatNum(m.input_tokens), 'включая cache')}
        ${metricCard('Без кэша', formatNum(m.uncached_input_tokens), 'input − cache')}
        ${metricCard('Выход', formatNum(m.output_tokens), 'completion')}
        ${metricCard('Всего', formatNum(m.total_tokens), 'ход')}
      </div>
      <div class="muted">cache read ${escapeHtml(formatNum(m.cache_read_tokens))} · cache write ${escapeHtml(formatNum(m.cache_write_tokens))}</div>`
    : '<p class="empty">В payload stop не было полей токенов.</p>';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
  h1 { font-size: 14px; margin: 0 0 8px; }
  h2 { font-size: 12px; margin: 16px 0 8px; opacity: .9; }
  select, button { font: inherit; color: inherit; }
  select { width: 100%; padding: 6px 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
  .toolbar button { padding: 4px 10px; background: var(--vscode-button-secondaryBackground); border: none; border-radius: 4px; cursor: pointer; }
  .turns { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; }
  .turn { display: grid; grid-template-columns: 40px 1fr; gap: 2px 8px; text-align: left; padding: 8px; border: 1px solid var(--vscode-panel-border, transparent); background: transparent; border-radius: 6px; cursor: pointer; }
  .turn span { grid-row: span 2; opacity: .6; align-self: center; }
  .turn.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .metric { padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, transparent); }
  .metric span, .metric small { display: block; opacity: .7; font-size: 11px; }
  .metric strong { display: block; font-size: 16px; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 6px 4px; border-bottom: 1px solid var(--vscode-panel-border, transparent); text-align: left; }
  td:last-child, th:last-child { text-align: right; }
  .muted, .empty { opacity: .7; font-size: 12px; }
</style>
</head>
<body>
  <h1>Token Lens</h1>
  <div class="toolbar">
    <select id="chat">${chatOptions || '<option value=\"\">Нет чатов</option>'}</select>
    <button id="refresh">↻</button>
  </div>
  <h2>Ходы</h2>
  <div class="turns" id="turns">${turnButtons || '<p class="empty">Пока нет ходов.</p>'}</div>
  <h2>Фактически (API)</h2>
  ${measuredBlock}
  <h2>Потребители (оценка)</h2>
  <p class="muted">UTF-8 байт / 3 · не биллинг · модель ${escapeHtml((turn && turn.model) || '—')}</p>
  <table>
    <thead><tr><th>Инструмент</th><th>≈ токены</th></tr></thead>
    <tbody>${consumerRows}</tbody>
  </table>
  <h2>Категории</h2>
  <table>
    <tbody>
      <tr><td>Результаты инструментов</td><td>${escapeHtml(formatNum(cats.tool_results || 0))}</td></tr>
      <tr><td>Вызовы инструментов</td><td>${escapeHtml(formatNum(cats.tool_calls || 0))}</td></tr>
    </tbody>
  </table>
  <script>
    const vscode = acquireVsCodeApi();
    const chat = document.getElementById('chat');
    if (chat) chat.addEventListener('change', () => vscode.postMessage({ type: 'selectChat', id: chat.value }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('turns').addEventListener('click', (event) => {
      const btn = event.target.closest('button.turn');
      if (!btn) return;
      vscode.postMessage({ type: 'selectTurn', index: Number(btn.dataset.index) });
    });
  </script>
</body>
</html>`;
}

class PanelController {
  constructor() {
    this.panel = null;
    this.selectedChatId = null;
    this.selectedTurnIndex = null;
  }

  open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'tokenLensPanel',
      'Token Lens',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'selectChat') {
        this.selectedChatId = message.id || null;
        this.selectedTurnIndex = null;
        this.refresh();
      } else if (message.type === 'selectTurn') {
        this.selectedTurnIndex = Number.isInteger(message.index) ? message.index : null;
        this.refresh();
      } else if (message.type === 'refresh') {
        this.refresh();
      }
    });
    this.refresh();
  }

  refresh() {
    if (!this.panel) return;
    const active = readJson(ACTIVE_PATH, {});
    const status = readJson(STATUS_PATH, {});
    const index = readJson(INDEX_PATH, []);
    if (!this.selectedChatId) {
      this.selectedChatId = active.conversation_id || status.conversation_id || (index[0] && index[0].conversation_id) || null;
    }
    const chat = this.selectedChatId ? loadChat(this.selectedChatId) : null;
    const turns = chat && Array.isArray(chat.turns) ? chat.turns : [];
    if (this.selectedTurnIndex == null && turns.length) this.selectedTurnIndex = turns.length - 1;
    if (this.selectedTurnIndex != null && this.selectedTurnIndex >= turns.length) {
      this.selectedTurnIndex = turns.length ? turns.length - 1 : null;
    }
    const turn = this.selectedTurnIndex != null ? turns[this.selectedTurnIndex] : null;
    this.panel.webview.html = renderHtml({
      index,
      selectedChatId: this.selectedChatId,
      chat,
      selectedTurnIndex: this.selectedTurnIndex,
      turn,
      status,
    });
  }
}

function activate(context) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      MARKER_PATH,
      JSON.stringify({ at: new Date().toISOString(), ok: true, version: '0.1.2' }, null, 2)
    );
  } catch {
    // ignore
  }

  const controller = new PanelController();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBar.name = 'Token Lens';
  statusBar.command = 'tokenLens.openPanel';
  statusBar.text = 'TokenLens';
  statusBar.tooltip = 'Token Lens — открыть разбор расхода';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const refreshStatus = () => {
    const status = readJson(STATUS_PATH, null);
    if (status && status.text) {
      statusBar.text = `TokenLens ${status.text}`;
      statusBar.tooltip = status.detail || 'Token Lens';
    } else {
      statusBar.text = 'TokenLens';
      statusBar.tooltip = 'Пока нет данных — дождитесь завершения ответа агента';
    }
    controller.refresh();
  };

  refreshStatus();
  const timer = setInterval(refreshStatus, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.openPanel', () => controller.open()),
    vscode.commands.registerCommand('tokenLens.refresh', () => refreshStatus()),
    vscode.commands.registerCommand('tokenLens.openLatest', async () => {
      if (!fs.existsSync(LATEST_MD)) {
        vscode.window.showInformationMessage('Token Lens: отчёта ещё нет.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(LATEST_MD));
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  vscode.window.showInformationMessage('Token Lens 0.1.2 активен. Слева в status bar: TokenLens. Или Command Palette → Token Lens: Open Panel');
}

function deactivate() {}

module.exports = { activate, deactivate };
