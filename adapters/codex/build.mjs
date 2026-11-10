import { build, transform } from 'esbuild';
import fs from 'node:fs';
import assert from 'node:assert/strict';

fs.mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/server.mjs'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/server.cjs' });
await build({ entryPoints: ['src/link.cjs'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/link.cjs' });
const js = await build({ entryPoints: ['src/panel.js'], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, write: false });
const css = await build({ entryPoints: ['src/panel.css'], bundle: true, minify: true, write: false });
const html = fs.readFileSync('src/panel.html', 'utf8').replace('/* STYLES */', () => css.outputFiles[0].text).replace('/* APP */', () => js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')).replace('<script>', '<script type="module">');
assert(!html.includes('/* APP */'), 'JavaScript replacement must not expand $ replacement sequences');
await transform(html.split('<script type="module">')[1].split('</script>')[0], { loader: 'js', format: 'esm' });
fs.writeFileSync('dist/panel.html', html);
fs.mkdirSync('package/dist', { recursive: true });
for (const file of ['plugin.json', 'mcp.json']) fs.copyFileSync(file, `package/${file}`);
for (const file of ['server.cjs', 'link.cjs', 'panel.html']) fs.copyFileSync(`dist/${file}`, `package/dist/${file}`);
fs.cpSync('skills', 'package/skills', { recursive: true });
fs.cpSync('scripts', 'package/scripts', { recursive: true });
console.log('Built local MCP server and self-contained panel.');
