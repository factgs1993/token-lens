const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('./config.cjs');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function createReportState(home, now = Date.now) {
  function marker(sessionId, turnId) {
    if (![sessionId, turnId].every(validId)) throw new Error('Некорректный ID отчёта.');
    return path.join(home, 'token-lens', 'deleted-reports', sessionId, `${turnId}.json`);
  }
  const deleted = (sessionId, turnId) => fs.existsSync(marker(sessionId, turnId));
  function remove(reports) {
    if (!Array.isArray(reports) || reports.length < 1 || reports.length > 200) throw new Error('Выберите от 1 до 200 отчётов.');
    const files = reports.map(row => marker(row?.sessionId, row?.turnId));
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { fs.writeFileSync(file, JSON.stringify({ deletedAt: new Date(now()).toISOString() }), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return { deleted: reports.length };
  }
  function visible(sessionId, turns) {
    const days = readConfig(home).autoDeleteDays;
    if (days) for (const turn of turns) {
      const at = Date.parse(turn.startedAt || turn.requests[0]?.at);
      if (turn.status !== 'running' && Number.isFinite(at) && at < now() - days * 86400000 && !deleted(sessionId, turn.id)) remove([{ sessionId, turnId: turn.id }]);
    }
    return turns.filter(turn => !deleted(sessionId, turn.id));
  }
  return { deleted, remove, visible };
}
module.exports = { createReportState };
