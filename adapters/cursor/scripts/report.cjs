'use strict';

const fs = require('node:fs');
const { LATEST_JSON, LATEST_MD, renderMarkdown } = require('./lib.cjs');

const mode = process.argv[2] || 'md';
if (mode === 'json') {
  if (!fs.existsSync(LATEST_JSON)) {
    console.error('Пока нет отчёта. Дождитесь завершения ответа агента.');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(LATEST_JSON, 'utf8'));
  process.exit(0);
}

if (fs.existsSync(LATEST_MD)) {
  process.stdout.write(fs.readFileSync(LATEST_MD, 'utf8'));
  process.exit(0);
}

if (fs.existsSync(LATEST_JSON)) {
  const report = JSON.parse(fs.readFileSync(LATEST_JSON, 'utf8'));
  process.stdout.write(renderMarkdown(report));
  process.exit(0);
}

console.error('Пока нет отчёта. Дождитесь завершения ответа агента.');
process.exit(1);
