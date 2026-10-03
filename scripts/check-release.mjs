import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const problems = [];
let localLinks = 0;

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Examples inside code fences/inline code are not document navigation.
function prose(markdown) {
  let fence;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return '';
      }
      return fence ? '' : line.replace(/`+[^`\n]*`+/g, '');
    })
    .join('\n');
}

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
  const markdown = prose(await readFile(path.join(root, entry.name), 'utf8'));
  const links = [
    ...markdown.matchAll(
      /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g
    ),
    ...markdown.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm),
  ];
  for (const match of links) {
    const target = match[1] ?? match[2];
    if (!target || target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    let pathname;
    try {
      pathname = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    } catch {
      problems.push(`${entry.name}: invalid link encoding: ${target}`);
      continue;
    }
    if (!pathname) continue;
    localLinks++;
    const resolved = path.resolve(root, pathname.startsWith('/') ? `.${pathname}` : pathname);
    if (!(await exists(resolved))) problems.push(`${entry.name}: missing link target: ${target}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const target of manifest.files ?? []) {
  if (typeof target !== 'string' || /[*?\[\]{}!]/.test(target)) {
    problems.push(`package.json: files entry must be a literal path: ${String(target)}`);
  } else if (!(await exists(path.resolve(root, target)))) {
    problems.push(`package.json: missing files entry: ${target}`);
  }
}

if (problems.length) {
  console.error(`Release checks failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release checks passed: ${localLinks} local documentation links, ${manifest.files?.length ?? 0} package paths.`
  );
}
