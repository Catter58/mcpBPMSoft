import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function sourceFingerprint(files) {
  const hash = createHash('sha256').update('production-ts-path-content-v1\0');
  for (const [path, content] of files.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    hash.update(path).update('\0').update(String(content.length)).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

async function workingSourceFiles(directory = 'src') {
  const files = [];
  for (const entry of await readdir(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await workingSourceFiles(path)));
    else if (entry.isFile() && path.endsWith('.ts'))
      files.push([path, await readFile(join(repositoryRoot, path))]);
  }
  return files;
}

/** Identifies production sources, including new files that are not tracked by Git yet. */
export async function productionProvenance({ baseline = false, commit = 'HEAD' } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot });
  const baseCommit = git(['rev-parse', commit]).toString('utf8').trim();
  const headPaths = git(['ls-tree', '-r', '--name-only', baseCommit, '--', 'src'])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.ts'));
  const headFiles = headPaths.map((path) => [path, git(['show', `${baseCommit}:${path}`])]);
  const headFingerprint = sourceFingerprint(headFiles);
  const sourceFiles = baseline ? headFiles : await workingSourceFiles();
  const fingerprint = sourceFingerprint(sourceFiles);
  const lock = baseline
    ? git(['show', `${baseCommit}:package-lock.json`])
    : await readFile(join(repositoryRoot, 'package-lock.json'));
  const modified = fingerprint !== headFingerprint;
  return {
    base_source_commit: baseCommit,
    implementation_state: modified ? 'working-tree candidate' : 'baseline',
    production_source_modified: modified,
    production_source_sha256: fingerprint,
    head_production_source_sha256: headFingerprint,
    production_source_file_count: sourceFiles.length,
    source_fingerprint_format:
      'SHA256 of production-ts-path-content-v1 NUL, then sorted src/**/*.ts path NUL byte-length NUL file-bytes NUL.',
    dependency_lock_sha256: createHash('sha256').update(lock).digest('hex'),
    compiled_from: baseline
      ? `Tracked production sources at ${baseCommit}; baseline build was completed before production edits.`
      : 'Working-tree production sources; run npm run build immediately before this experiment.',
  };
}

/** Adds provenance and fixture sizes without modifying any measured numeric value. */
export function annotateExperimentMetadata(report, provenance) {
  const { source_commit: _legacyCommit, notes_utf8_bytes: _legacyNotesBytes, ...existing } = report;
  return {
    ...existing,
    default_notes_utf8_bytes: 2048,
    ...provenance,
    observations: report.observations.map((observation) => ({
      ...observation,
      notes_utf8_bytes:
        observation.scenario === 'oversized_single_row'
          ? 80 * 1024
          : observation.scenario === 'raw_512k_guard'
            ? 600 * 1024
            : 2048,
    })),
  };
}
