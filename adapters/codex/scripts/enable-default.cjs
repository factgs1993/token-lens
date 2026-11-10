const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const helper = path.join(codexHome, 'tools', 'token-usage-link.cjs');
const instructions = path.join(codexHome, 'AGENTS.md');
const start = '<!-- codex-token-lens-default:start -->';
const end = '<!-- codex-token-lens-default:end -->';
const section = `${start}
## Token statistics after every answer

The user wants a token-statistics link at the end of every final Codex answer, in every project, without mentioning or explicitly activating a plugin.

Immediately before each final answer, run this local helper once using the shell tool:

    node "${helper}"

Append the returned \`markdown\` value unchanged on the last line of the final answer. It is labelled “📊 Токены этого ответа” and binds the current chat and turn. Do not reuse a link from an earlier answer, invent IDs, require a plugin mention, or open the report automatically. The helper uses CODEX_THREAD_ID; the report opens locally without a model request. If the helper fails, state the specific failure briefly instead of fabricating counts or a link.
${end}`;

let current = fs.existsSync(instructions) ? fs.readFileSync(instructions, 'utf8') : '';
const beginAt = current.indexOf(start);
if (beginAt >= 0) {
  const endAt = current.indexOf(end, beginAt);
  if (endAt < 0) throw new Error('Incomplete token-lens section in AGENTS.md; refusing to overwrite.');
  current = current.slice(0, beginAt) + section + current.slice(endAt + end.length);
} else current = current.trimEnd() + (current.trim() ? '\n\n' : '') + section + '\n';
fs.mkdirSync(path.dirname(helper), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../dist/link.cjs'), helper);
fs.writeFileSync(instructions, current);
console.log(JSON.stringify({ instructions, helper, enabled: true }));
