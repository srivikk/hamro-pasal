#!/usr/bin/env node
/*
 * Phase 7 (2026-10-22): zero-downtime migration guard, run by CI on every push.
 *
 * Deploys apply migrations BEFORE the new containers start, while the old ones still serve traffic
 * (infra/deploy/README.md). So every new migration must be "expand only": the code already running
 * has to keep working on the migrated schema. This script reads the migrations added since a base
 * git ref and refuses statements that break running code:
 *
 *   DROP TABLE / DROP COLUMN / DROP TYPE / RENAME (table, column, value) / ALTER COLUMN ... TYPE /
 *   ALTER COLUMN ... SET NOT NULL / ADD COLUMN ... NOT NULL without a DEFAULT
 *
 * Removing something is a second, "contract" release after the code stopped using it. Mark such a
 * file with a line `-- deploy: contract` (and say why); the guard then lets it through.
 *
 * Usage: node infra/ci/check-migrations.mjs [base-ref]   (default: origin/main, else main)
 * Exit 0 when every new migration is safe, 1 otherwise (each finding names file, line and rule).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MIGRATIONS = 'packages/db/drizzle';

/**
 * Migrations written before this guard existed and reviewed by hand as safe for old code
 * (2026-10-22). Never add to this list: mark a new file with "-- deploy: contract" instead.
 */
const REVIEWED = new Map([
  [
    '0042_dispute_hold_and_escalation.sql',
    'dispute_status is rebuilt with every old value plus new ones, in one transaction',
  ],
]);

const RULES = [
  { name: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { name: 'DROP TYPE', pattern: /\bDROP\s+TYPE\b/i },
  { name: 'RENAME', pattern: /\bRENAME\s+(TO|COLUMN|VALUE|CONSTRAINT)\b/i },
  {
    name: 'ALTER COLUMN ... TYPE',
    pattern: /\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i,
  },
  { name: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  {
    name: 'ADD COLUMN ... NOT NULL without DEFAULT',
    pattern: /\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i,
  },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function baseRef(argument) {
  if (argument !== undefined) return argument;
  for (const candidate of ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', candidate]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Strips SQL comments so a rule never matches an explanation. */
function stripComments(line) {
  return line.replace(/--.*$/, '');
}

function findUnsafeStatements(sql) {
  if (/^\s*--\s*deploy:\s*contract\b/im.test(sql)) return [];
  // A column added by this same file is new to the running code too: making it NOT NULL after a
  // backfill and a DEFAULT in the same migration breaks nothing.
  const addedHere = new Set(
    [...sql.matchAll(/\bADD\s+COLUMN\s+"?(\w+)"?/gi)].map((match) => match[1].toLowerCase()),
  );
  const findings = [];
  sql.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComments(raw);
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.name === 'SET NOT NULL') {
        const column = /ALTER\s+COLUMN\s+"?(\w+)"?/i.exec(line)?.[1]?.toLowerCase();
        if (column !== undefined && addedHere.has(column)) continue;
      }
      findings.push({ line: index + 1, rule: rule.name });
    }
  });
  return findings;
}

function main() {
  const base = baseRef(process.argv[2]);
  if (base === null) {
    console.warn('[migrations] no base ref (origin/main or main): nothing to compare, skipping');
    return 0;
  }
  const changed = git([
    'diff',
    '--name-only',
    '--diff-filter=A',
    `${base}...HEAD`,
    '--',
    MIGRATIONS,
  ])
    .split('\n')
    .filter((file) => file.endsWith('.sql'));
  let problems = 0;
  for (const file of changed) {
    const reviewed = REVIEWED.get(file.split('/').pop());
    if (reviewed !== undefined) {
      console.info(`[migrations] ${file}: reviewed by hand (${reviewed})`);
      continue;
    }
    for (const finding of findUnsafeStatements(readFileSync(file, 'utf8'))) {
      problems += 1;
      console.error(
        `[migrations] ${file}:${String(finding.line)}: ${finding.rule} breaks the code still ` +
          'running during a deploy. Ship it as a later "contract" release and mark the file ' +
          'with "-- deploy: contract".',
      );
    }
  }
  const verdict = problems === 0 ? 'all expand-only' : `${String(problems)} problem(s)`;
  console.info(`[migrations] ${String(changed.length)} new migration(s) since ${base}: ${verdict}`);
  return problems === 0 ? 0 : 1;
}

process.exitCode = main();
