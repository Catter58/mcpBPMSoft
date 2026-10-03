#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { runContextBudget } from './lib/context-budget.mjs';
import { productionProvenance, annotateExperimentMetadata } from './lib/context-budget-provenance.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw new Error('Usage: node scripts/context-budget.mjs [--output PATH] (after npm run build)');
process.env.BPMSOFT_METADATA_CACHE = 'off';
const provenance = await productionProvenance();
const report = annotateExperimentMetadata(await runContextBudget(), provenance);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (args[0] === '--output') await writeFile(args[1], json, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(json);
