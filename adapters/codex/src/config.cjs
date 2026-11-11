const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const defaults = { reportView: 'mcp' };
const configPath = (home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) => path.join(home, 'token-lens', 'config.json');

function readConfig(home) {
  const file = configPath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error; }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Некорректный JSON в ${file}. Файл не изменён.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'reportView')) {
    throw new Error(`В ${file} ожидается объект с параметром reportView (mcp или browser). Файл не изменён.`);
  }
  const reportView = value.reportView === undefined ? defaults.reportView : value.reportView;
  if (!['mcp', 'browser'].includes(reportView)) throw new Error(`В ${file}: reportView должен быть mcp или browser. Файл не изменён.`);
  return { reportView };
}

function ensureConfig(home) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return readConfig(home);
}
module.exports = { configPath, readConfig, ensureConfig };
