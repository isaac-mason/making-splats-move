// Writes the Pages landing page, listing the examples from the README's table.
//   node scripts/pages-index.mjs site/index.html

import { readFileSync, writeFileSync } from 'node:fs';

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const examples = [...readFileSync('README.md', 'utf8').matchAll(/^\| \[`(\w[\w-]*)\/`\]\(\w[\w-]*\) \| (.+) \|$/gm)].map(
    ([, name, what]) => ({ name, what: escape(what).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') }),
);

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>making splats move</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        background: #0b0b0d;
        color: #e8e6e3;
        font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      main { max-width: 44rem; margin: 0 auto; padding: 4rem 1rem; }
      h1 { font-size: 1.6rem; font-weight: 600; margin: 0 0 0.5rem; }
      p { color: #9a968f; margin: 0 0 2.5rem; }
      ul { list-style: none; margin: 0; padding: 0; }
      li a {
        display: block;
        padding: 1rem 0;
        border-top: 1px solid #222;
        color: inherit;
        text-decoration: none;
      }
      li a:hover strong { color: #ffb45e; }
      strong { display: block; font-weight: 600; }
      span { color: #9a968f; }
      code { font-size: 0.9em; }
      a.repo { color: #9a968f; }
    </style>
  </head>
  <body>
    <main>
      <h1>making splats move</h1>
      <p>Gaussian splat scenes brought to life, drawn with <a class="repo" href="https://sparkjs.dev/radix/">Radix</a>. Needs WebGPU, or falls back to WebGL2. <a class="repo" href="https://github.com/isaac-mason/making-splats-move-radix">Source</a>.</p>
      <ul>
${examples.map(({ name, what }) => `        <li><a href="${name}/"><strong>${name}</strong><span>${what}</span></a></li>`).join('\n')}
      </ul>
    </main>
  </body>
</html>
`;

writeFileSync(process.argv[2], html);
console.log(`${examples.length} examples`);
