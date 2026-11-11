import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { createReportView } from './view.js';
import { createLibrary } from './library.js';
const app = new App({ name: 'codex-token-lens', version: '0.4.2' }, { availableDisplayModes: ['inline', 'fullscreen'] });
let connected = false;
async function call(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Ошибка Token Lens');
  return result.structuredContent;
}
const view = createReportView({
  getReport: async binding => {
    const result = await app.callServerTool({ name: 'read_token_report', arguments: binding });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || 'Ошибка чтения журнала');
    return result.structuredContent;
  },
  openExternal: async url => { if ((await app.openLink({ url })).isError) throw new Error('Не удалось открыть браузер. Используйте ссылку HTML в конце ответа.'); }
});
const library = createLibrary({ view, list: args => call('list_token_reports', args), readSettings: () => call('read_token_settings'), saveSettings: args => call('save_token_settings', args), remove: reports => call('delete_token_reports', { reports }) });
function host(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.safeAreaInsets) for (const side of ['top', 'right', 'bottom', 'left']) document.documentElement.style.setProperty(`--safe-${side}`, `${context.safeAreaInsets[side] || 0}px`);
  const route = context?.['openai/deepLink']?.url;
  if (typeof route !== 'string' || !connected) return;
  try {
    const url = new URL(route, 'https://token-lens.invalid');
    if (['/reports', '/settings'].includes(url.pathname)) { library.show(url.pathname.slice(1)); return; }
    const sessionId = url.searchParams.get('sessionId'), turnId = url.searchParams.get('turnId');
    if (url.pathname !== '/answer' || ![sessionId, turnId].every(id => /^[a-zA-Z0-9_-]{1,100}$/.test(id || ''))) throw new Error('Некорректная ссылка на ответ.');
    library.open({ sessionId, turnId });
  } catch(error) { document.getElementById('status').textContent = error.message; document.getElementById('content').hidden = true; }
}
app.onhostcontextchanged = host;
await app.connect(); connected = true; host(app.getHostContext());
if (!app.getHostContext()?.['openai/deepLink']) library.show('reports');
