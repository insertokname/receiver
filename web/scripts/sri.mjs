// SPDX-License-Identifier: AGPL-3.0-only
//
// Subresource Integrity for a built page: every <script src>, stylesheet and
// modulepreload in the HTML gets an `integrity` attribute (SHA-384 of the
// file), and an import map lists the digest of every JavaScript module the
// page's module scripts import, statically or dynamically (import map
// `integrity`, so the browser checks chunks loaded later too). The import
// map is an inline script: its SHA-256 is added to the page's CSP
// script-src. WebAssembly and data are checked by the code that fetches
// them, against digests compiled into that (now SRI-covered) code.
//
//   node scripts/sri.mjs PAGE.html [PAGE.html ...]
//
// Runs on the final files: anything that changes a referenced file
// afterwards breaks the page (as it should).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sri = bytes => `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
const cspHash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

// Relative module specifiers in (minified or not) ES module code:
// `from "./x.js"`, `import "./x.js"`, `import("./x.js")`, `export * from`,
// with any quotes (the minifier writes import(`./x.js`)).
const IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*(["'`])(\.{1,2}\/[^"'`\s]+?\.m?js)\1/g;

async function moduleGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const code = await readFile(file, 'utf8');
    for (const [, , specifier] of code.matchAll(IMPORT_RE)) {
      const target = resolve(dirname(file), specifier);
      // A specifier-like string that is no file of the site (in a comment
      // or a string) is not an import.
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort();
}

/** Adds SRI to `htmlPath` in place. Returns the number of modules covered. */
export async function addIntegrity(htmlPath) {
  const dir = dirname(htmlPath);
  let html = await readFile(htmlPath, 'utf8');
  if (/<script type="importmap"/.test(html)) throw new Error(`${htmlPath}: already has an import map`);
  const url = path => {
    const rel = relative(dir, path).split(sep).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  const local = ref => {
    if (/^[a-z]+:|^\/\//i.test(ref)) throw new Error(`${htmlPath}: ${ref}: only same-site files can be checked`);
    const path = join(dir, ref.split(/[?#]/)[0]);
    if (!existsSync(path)) throw new Error(`${htmlPath}: ${ref} not found`);
    return path;
  };

  const moduleEntries = [];
  const withIntegrity = async (tag, attr) => {
    const ref = tag.match(new RegExp(`\\s${attr}="([^"]+)"`))[1];
    const path = local(ref);
    if (/\stype="module"/.test(tag)) moduleEntries.push(path);
    const digest = sri(await readFile(path));
    const stripped = tag.replace(/\sintegrity="[^"]*"/, '');
    return stripped.replace(/\s*\/?>$/, m => ` integrity="${digest}"${m}`);
  };
  for (const tag of html.match(/<script\b[^>]*\ssrc="[^"]+"[^>]*>/g) ?? []) {
    html = html.replace(tag, await withIntegrity(tag, 'src'));
  }
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    if (!/\srel="(stylesheet|modulepreload)"/.test(tag)) continue;
    html = html.replace(tag, await withIntegrity(tag, 'href'));
  }

  const modules = await moduleGraph(moduleEntries);
  if (modules.length > 0) {
    const integrity = {};
    for (const path of modules) integrity[url(path)] = sri(await readFile(path));
    const map = JSON.stringify({ integrity });
    const firstModule = html.search(/<script\b[^>]*\stype="module"/);
    const csp = html.match(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/);
    if (firstModule < 0 || !csp) throw new Error(`${htmlPath}: needs a module script and a CSP meta tag`);
    const scriptSrc = csp[2].match(/script-src ([^;]*);/);
    if (!scriptSrc) throw new Error(`${htmlPath}: CSP has no script-src`);
    const indent = html.slice(html.lastIndexOf('\n', firstModule) + 1, firstModule);
    html = `${html.slice(0, firstModule)}<script type="importmap">${map}</script>\n${indent}${html.slice(firstModule)}`;
    html = html.replace(
      csp[0],
      `${csp[1]}${csp[2].replace(scriptSrc[0], `script-src ${scriptSrc[1].trimEnd()} ${cspHash(map)};`)}${csp[3]}`
    );
  }
  await writeFile(htmlPath, html);
  return modules.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = process.argv.slice(2);
  if (pages.length === 0) throw new Error('usage: node scripts/sri.mjs PAGE.html [PAGE.html ...]');
  for (const page of pages) {
    const modules = await addIntegrity(page);
    console.log(`sri: ${relative(process.cwd(), page)}: ${modules} modules in the import map`);
  }
}
