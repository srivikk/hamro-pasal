#!/usr/bin/env node
/*
 * 2026-10-22: guards against a crash that only shows on a phone. Hermes (the apps' JavaScript
 * engine) lacks some globals Node and browsers have; code that runs `new <one of them>(...)` when a
 * module loads crashes the app before React starts ("[runtime not ready]: TypeError: undefined
 * cannot be used as a constructor"). That is what a module-level `new Intl.Segmenter(...)` in
 * packages/shared-types did to both apps. Jest runs on Node and cannot see it.
 *
 * This script exports the Android development bundle (what Metro serves the dev clients), parses
 * every module and fails when OUR code (apps/mobile, packages/*) constructs one of those globals
 * outside a function, i.e. at load. Third-party modules are not judged here.
 *
 * Usage: node infra/ci/check-hermes-startup.mjs [--variant customer|seller] [--bundle <file>]
 * (--bundle skips the export and scans an existing bundle.)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { parse } = require('@babel/parser');

/** Globals Hermes does not provide (React Native 0.86): never construct them at module load. */
const MISSING_ON_HERMES = new Set([
  'Intl.Segmenter',
  'EventTarget',
  'Event',
  'CustomEvent',
  'BroadcastChannel',
  'MessageChannel',
  'DOMException',
  'FinalizationRegistry',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'CompressionStream',
  'DecompressionStream',
  'Worker',
]);

/** Our own modules, as Metro names them relative to apps/mobile. */
const OURS = /^(?:\.\/|\.\.\/\.\.\/packages\/|(?:app|src)\/)/;

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

function args() {
  const list = process.argv.slice(2);
  const value = (flag) => {
    const index = list.indexOf(flag);
    return index === -1 ? undefined : list[index + 1];
  };
  return { variant: value('--variant') ?? 'customer', bundle: value('--bundle') };
}

function exportBundle(variant) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'hermes-check-'));
  const result = spawnSync(
    'npx',
    [
      'expo',
      'export',
      '--platform',
      'android',
      '--dev',
      '--no-minify',
      '--no-bytecode',
      '--output-dir',
      out,
    ],
    {
      cwd: path.join(ROOT, 'apps', 'mobile'),
      env: { ...process.env, APP_VARIANT: variant, EXPO_OFFLINE: '1', CI: '1' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) throw new Error(`expo export failed (${String(result.status)})`);
  const dir = path.join(out, '_expo', 'static', 'js', 'android');
  const file = readdirSync(dir).find((name) => name.endsWith('.js'));
  if (file === undefined) throw new Error('no Android bundle was written');
  return {
    file: path.join(dir, file),
    cleanup: () => rmSync(out, { recursive: true, force: true }),
  };
}

function constructorName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    return `${callee.object.name}.${callee.property.name}`;
  }
  return null;
}

/** `new X(...)` reached when the module loads (not inside a function). */
function loadTimeConstructions(node, code, found) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) loadTimeConstructions(child, code, found);
    return;
  }
  if (FUNCTIONS.has(node.type)) return;
  if (node.type === 'NewExpression') {
    const name = constructorName(node.callee);
    if (name !== null && MISSING_ON_HERMES.has(name)) {
      found.push(code.slice(node.start, Math.min(node.end, node.start + 80)).replace(/\s+/g, ' '));
    }
  }
  for (const key of Object.keys(node)) {
    if (key !== 'loc' && key !== 'start' && key !== 'end')
      loadTimeConstructions(node[key], code, found);
  }
}

function scan(file) {
  const code = readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'script', errorRecovery: true });
  const problems = [];
  let modules = 0;
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === '__d'
    ) {
      modules += 1;
      const [factory, , , name] = node.arguments;
      const modulePath = name?.type === 'StringLiteral' ? name.value : '';
      if (OURS.test(modulePath) && factory?.body !== undefined) {
        const found = [];
        loadTimeConstructions(factory.body.body, code, found);
        for (const snippet of found) problems.push(`${modulePath}: ${snippet}`);
      }
      return;
    }
    for (const key of Object.keys(node)) if (key !== 'loc') visit(node[key]);
  };
  visit(ast.program);
  return { modules, problems };
}

const options = args();
const exported = options.bundle === undefined ? exportBundle(options.variant) : null;
try {
  const { modules, problems } = scan(options.bundle ?? exported.file);
  if (problems.length > 0) {
    console.error(
      `[hermes] ${String(problems.length)} module-level construction(s) of a global Hermes lacks; ` +
        'the app would crash at start. Create it on first use instead:\n  ' +
        problems.join('\n  '),
    );
    process.exitCode = 1;
  } else {
    console.info(
      `[hermes] ${String(modules)} modules scanned: nothing constructs a missing global at load`,
    );
  }
} finally {
  exported?.cleanup();
}
