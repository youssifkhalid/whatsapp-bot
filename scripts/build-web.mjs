// Dashboard build: esbuild (JS) + Tailwind CSS 4 compile API (CSS). No Vite needed.
// Usage: node scripts/build-web.mjs        -> dist/web
// On a networked machine this can be replaced by Vite; the output contract (dist/web/index.html + /assets) is the same.
import { build, transform } from 'esbuild';
import { compile } from 'tailwindcss';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/web');
const out = join(root, 'dist/web');
const assets = join(out, 'assets');

rmSync(out, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

// ---- JS
const js = await build({
  entryPoints: [join(src, 'main.tsx')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  outfile: join(assets, 'app.js'),
});
const jsText = js.outputFiles[0].text;

// ---- CSS: gather every class-like token from the sources, let Tailwind generate only what is used.
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const candidates = new Set();
for (const file of walk(src).filter((f) => ['.tsx', '.ts', '.html', '.css'].includes(extname(f)))) {
  for (const tok of readFileSync(file, 'utf8').split(/[\s"'`<>{};]+/)) if (tok) candidates.add(tok);
}
const nm = join(root, 'node_modules');
const compiler = await compile(readFileSync(join(src, 'styles.css'), 'utf8'), {
  base: src,
  async loadStylesheet(id, base) {
    let path;
    if (id === 'tailwindcss') path = join(nm, 'tailwindcss/index.css');
    else if (id.startsWith('tailwindcss/')) path = join(nm, id.endsWith('.css') ? id : `${id}.css`);
    else path = resolve(base, id);
    return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
  },
});
const rawCss = compiler.build([...candidates]);
const css = (await transform(rawCss, { loader: 'css', minify: true, target: 'es2022' })).code;

// ---- hashed names + html
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const jsName = `app-${hash(jsText)}.js`;
const cssName = `app-${hash(css)}.css`;
writeFileSync(join(assets, jsName), jsText);
writeFileSync(join(assets, cssName), css);
cpSync(join(src, 'theme-init.js'), join(assets, 'theme-init.js'));
cpSync(join(src, 'favicon.svg'), join(assets, 'favicon.svg'));
writeFileSync(join(out, 'index.html'), readFileSync(join(src, 'index.html'), 'utf8').replace('__CSS__', cssName).replace('__JS__', jsName));

console.log(`dashboard built: ${jsName} ${(jsText.length / 1024).toFixed(0)} KB, ${cssName} ${(css.length / 1024).toFixed(0)} KB -> ${existsSync(out) ? 'dist/web' : '?'}`);
