// Rewrites invisible or ambiguous non-ASCII characters in .ts sources as \uXXXX
// escapes so they stay visible in review. Usage: node scripts/escape-invisible.mjs [--check] <dir>...
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const roots = args.filter((a) => !a.startsWith('--'));

// Format characters, non-ASCII spaces, line and paragraph separators, and the
// hyphen/dash block whose members are hard to tell apart.
const TARGET = /[\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}|[\u{2010}-\u{2015}]/gu;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

let changed = 0;
for (const root of roots.length ? roots : ['src']) {
  for (const file of walk(root)) {
    const before = readFileSync(file, 'utf8');
    const after = before.replace(TARGET, (ch) => '\\u' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
    if (after !== before) {
      changed++;
      console.log(`${check ? 'needs escaping' : 'escaped'}: ${file}`);
      if (!check) writeFileSync(file, after);
    }
  }
}
if (check && changed) process.exit(1);
