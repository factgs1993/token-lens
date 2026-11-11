import { createReportView } from './view.js';
const { report, baseUrl } = JSON.parse(document.getElementById('report-data').textContent);
const view = createReportView({
  live: !!baseUrl,
  getReport: async binding => {
    if (!baseUrl) return { report, baseUrl: null };
    const response = await fetch(`${baseUrl}/api/report?${new URLSearchParams(binding)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text());
    return { report: await response.json(), baseUrl };
  }
});
view.bind({ sessionId: report.sessionId, turnId: report.turnId });
