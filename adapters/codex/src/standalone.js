import { createReportView } from './view.js';
import { createLibrary } from './library.js';
const { report, baseUrl, page = 'report' } = JSON.parse(document.getElementById('report-data').textContent);
async function request(endpoint, body) {
  const response = await fetch(baseUrl + endpoint, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
const view = createReportView({
  live: !!baseUrl,
  getReport: async binding => {
    if (!baseUrl) return { report, baseUrl: null };
    const response = await fetch(`${baseUrl}/api/report?${new URLSearchParams(binding)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    return { report: await response.json(), baseUrl };
  }
});
if (baseUrl) {
  const library = createLibrary({ view, list: args => request('/api/reports?' + new URLSearchParams(args)), readSettings: () => request('/api/settings'), saveSettings: args => request('/api/settings', args), remove: reports => request('/api/reports/delete', { reports }) });
  if (report) library.open({ sessionId: report.sessionId, turnId: report.turnId }); else library.show(page);
} else view.bind({ sessionId: report.sessionId, turnId: report.turnId });
