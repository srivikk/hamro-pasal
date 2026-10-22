#!/usr/bin/env node
/*
 * Phase 7 (2026-10-22): the "safe sequential test watchdog". Runs a package's Jest test files ONE
 * AT A TIME, each in its own process with --testTimeout (default 10000 ms), and kills the whole
 * process tree of a file that runs past its wall-clock limit (Windows: taskkill /T /F; elsewhere
 * the process group). Parallel Jest runs with unbounded waits once took a developer machine down;
 * this is how tests are run locally and in CI.
 *
 * Usage:
 *   node infra/ci/run-jest-files.mjs <package dir> [--config <jest config>] [--file-timeout <s>]
 *                                   [--test-timeout <ms>] [--only <substring>]...
 *
 * Every file is listed by Jest itself (--listTests) under the given config. A failed or killed
 * file prints its full output; the run exits 1 when any file failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JEST = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

function parseArgs(argv) {
  const options = { config: null, fileTimeout: 600, testTimeout: 10_000, only: [] };
  const [dir, ...rest] = argv;
  if (dir === undefined) throw new Error('Usage: run-jest-files.mjs <package dir> [options]');
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--config') options.config = value;
    else if (flag === '--file-timeout') options.fileTimeout = Number(value);
    else if (flag === '--test-timeout') options.testTimeout = Number(value);
    else if (flag === '--only') options.only.push(value);
    else throw new Error(`Unknown option ${flag}`);
  }
  return { dir: path.resolve(dir), ...options };
}

function configArgs(options) {
  return options.config === null ? [] : ['--config', options.config];
}

function listTests(options) {
  const out = execFileSync(
    process.execPath,
    [JEST, ...configArgs(options), '--listTests', '--json'],
    {
      cwd: options.dir,
      encoding: 'utf8',
    },
  );
  const files = JSON.parse(out)
    .map((file) => path.relative(options.dir, file).replaceAll('\\', '/'))
    .sort();
  return options.only.length === 0
    ? files
    : files.filter((file) => options.only.some((part) => file.includes(part)));
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // already gone
  }
}

function runFile(file, options) {
  return new Promise((resolve) => {
    const args = [
      JEST,
      ...configArgs(options),
      '--runInBand',
      '--forceExit',
      `--testTimeout=${String(options.testTimeout)}`,
      '--runTestsByPath',
      file,
    ];
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: options.dir,
      env: { ...process.env, CI: process.env.CI ?? 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killTree(child);
    }, options.fileTimeout * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const summary = /Tests:\s+(.*)/.exec(output)?.[1] ?? 'no summary';
      const ok = code === 0 && !killed;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${seconds} s) ${summary}`);
      if (!ok) {
        if (killed) console.log(`  killed after ${String(options.fileTimeout)} s`);
        console.log(output);
      }
      resolve(ok);
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const files = listTests(options);
console.log(`${String(files.length)} test file(s) in ${path.relative(ROOT, options.dir) || '.'}`);
const failed = [];
for (const file of files) {
  if (!(await runFile(file, options))) failed.push(file);
}
console.log(
  failed.length === 0
    ? `All ${String(files.length)} file(s) passed`
    : `${String(failed.length)} file(s) failed:\n  ${failed.join('\n  ')}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
