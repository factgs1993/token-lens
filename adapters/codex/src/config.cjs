const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaults = { reportView: 'mcp', appendPlanLimits: false, autoDeleteDays: 0 };
const configPath = (home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) => path.join(home, 'token-lens', 'config.json');

function readConfig(home) {
  const file = configPath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error; }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Некорректный JSON в ${file}. Файл не изменён.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) {
    throw new Error(`В ${file} ожидаются reportView, appendPlanLimits и autoDeleteDays. Файл не изменён.`);
  }
  const reportView = value.reportView === undefined ? defaults.reportView : value.reportView;
  if (!['mcp', 'browser'].includes(reportView)) throw new Error(`В ${file}: reportView должен быть mcp или browser. Файл не изменён.`);
  const appendPlanLimits = value.appendPlanLimits === undefined ? defaults.appendPlanLimits : value.appendPlanLimits;
  const autoDeleteDays = value.autoDeleteDays === undefined ? defaults.autoDeleteDays : value.autoDeleteDays;
  if (typeof appendPlanLimits !== 'boolean' || !Number.isSafeInteger(autoDeleteDays) || autoDeleteDays < 0 || autoDeleteDays > 3650) {
    throw new Error(`В ${file}: appendPlanLimits — boolean, autoDeleteDays — целое от 0 до 3650. Файл не изменён.`);
  }
  return { reportView, appendPlanLimits, autoDeleteDays };
}

function writeConfig(patch, home) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(defaults, key))) throw new Error('Неизвестные настройки.');
  const next = { ...readConfig(home), ...patch };
  if (!['mcp', 'browser'].includes(next.reportView) || typeof next.appendPlanLimits !== 'boolean' || !Number.isSafeInteger(next.autoDeleteDays) || next.autoDeleteDays < 0 || next.autoDeleteDays > 3650) throw new Error('Некорректные настройки.');
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return next;
}

function ensureConfig(home) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readConfig(home);
}
module.exports = { configPath, readConfig, ensureConfig, writeConfig };
