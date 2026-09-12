#!/usr/bin/env node
/**
 * A second grading of a verified run.
 *
 * Reads a run folder, rebuilds each task's workspace from the archive the
 * manifest pins, obtains the pinned tests (from the benchmark repository at
 * the pinned commit, or from a sealed archive with the maintainer's key),
 * checks every file against the task-set pin, runs the tests, and compares
 * the verdicts with the manifest's. With --sign it writes regrade.json under a
 * grader key, so the verifier can reconcile two gradings under two keys.
 *
 *   node scripts/regrade.mjs --run <dir> [--sealed <path>] [--workspace-dir <dir>] [--sign] [--out <file>]
 *
 * The harness's verdict is the harness's word. This makes it two words, and
 * anyone can make a third.
 */
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(here, '../verify/legate-run.core.mjs');
const m = await import(pathToFileURL(corePath).href);
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const runDir = resolve(flag('--run', ''));
if (!flag('--run', '')) { console.error('usage: regrade.mjs --run <dir> [--sealed <path>] [--workspace-dir <dir>] [--sign] [--out <file>]'); process.exit(2); }
const sealedPath = flag('--sealed', '') ? resolve(flag('--sealed', '')) : null;
const workspaceDir = resolve(flag('--workspace-dir', join(runDir, 'workspace')));
const sign = args.includes('--sign');
const outPath = resolve(flag('--out', join(runDir, 'regrade.json')));
const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');
const gh = (path) => { const r = spawnSync('gh', ['api', path], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`gh api ${path}: ${r.stderr}`); return JSON.parse(r.stdout); };

const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
const taskSet = JSON.parse(readFileSync(join(runDir, 'task-set.json'), 'utf8'));

// The tests, from the sealed archive or the benchmark repository, checked against the pin before use.
const testFiles = {};
if (sealedPath) {
  const sealed = JSON.parse(readFileSync(sealedPath, 'utf8'));
  const keyHex = process.env.SEALED_TASKS_KEY ?? '';
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('SEALED_TASKS_KEY is required to open a sealed task set');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(sealed.iv, 'base64')); d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const body = JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]).toString('utf8'));
  for (const t of body.tasks) testFiles[t.id] = Object.fromEntries(Object.entries(t.files).filter(([p]) => p.startsWith('tests/')).map(([p, b64]) => [p, Buffer.from(b64, 'base64')]));
} else {
  for (const t of taskSet.tasks) {
    testFiles[t.id] = {};
    for (const f of t.files.filter((x) => x.path.startsWith('tests/'))) {
      const content = Buffer.from(gh(`repos/laude-institute/terminal-bench/contents/original-tasks/${t.id}/${f.path}?ref=${taskSet.revision}`).content, 'base64');
      testFiles[t.id][f.path] = content;
    }
  }
}
for (const t of taskSet.tasks) for (const f of t.files.filter((x) => x.path.startsWith('tests/'))) {
  const got = testFiles[t.id]?.[f.path];
  if (!got || sha256Bytes(got) !== f.sha256) throw new Error(`${t.id}/${f.path}: the test file obtained does not match the pin; refusing to grade`);
}

const results = [];
for (const attempt of manifest.attempts) {
  const archive = JSON.parse(readFileSync(join(workspaceDir, `${attempt.task_id}.json`), 'utf8'));
  if (!attempt.workspace) throw new Error(`${attempt.task_id}: the manifest pins no workspace for this attempt`);
  if (m.workspaceDigest(archive.files) !== attempt.workspace.digest) throw new Error(`${attempt.task_id}: the workspace archive is not the one the manifest pins`);
  if (archive.files.some((f) => f.content === undefined)) throw new Error(`${attempt.task_id}: the archive carries paths and digests only; the contents are held elsewhere (--workspace-dir)`);
  const ws = mkdtempSync(join(tmpdir(), `legate-regrade-${attempt.task_id}-`));
  try {
    for (const f of archive.files) {
      const buf = Buffer.from(f.content, 'base64');
      if (sha256Bytes(buf) !== f.sha256) throw new Error(`${attempt.task_id}/${f.path}: content does not match its digest`);
      const target = join(ws, 'app', f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, buf);
    }
    mkdirSync(join(ws, 'app'), { recursive: true });
    const testsDir = join(ws, '.legate-tests'); mkdirSync(testsDir);
    for (const [p, content] of Object.entries(testFiles[attempt.task_id])) { const target = join(testsDir, p.slice('tests/'.length)); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content.toString('utf8').replaceAll('/app', join(ws, 'app'))); }
    const py = spawnSync('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-rA', testsDir], { cwd: ws, encoding: 'utf8', timeout: 180_000 });
    const output = `${py.stdout ?? ''}${py.stderr ?? ''}`;
    const passed = Number(output.match(/(\d+) passed/)?.[1] ?? 0); const failed = Number(output.match(/(\d+) failed/)?.[1] ?? 0) + Number(output.match(/(\d+) error/)?.[1] ?? 0);
    const verdict = py.status === 0 && passed > 0 && failed === 0 ? 'pass' : py.status === null ? 'error' : 'fail';
    const runner = `pytest ${(spawnSync('python3', ['-m', 'pytest', '--version'], { encoding: 'utf8' }).stdout.match(/[\d.]+/) ?? ['?'])[0]}, regrade`;
    results.push({ task_id: attempt.task_id, attempt: attempt.attempt, verdict, tests: { runner, passed, failed, output_digest: m.fileDigest(output) }, workspace_digest: attempt.workspace.digest });
    console.log(`  ${attempt.task_id}: manifest ${attempt.verdict}, regrade ${verdict}${verdict === attempt.verdict ? '' : '  <-- DISAGREES'}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
}
const agree = results.every((r) => manifest.attempts.find((a) => a.task_id === r.task_id && a.attempt === r.attempt)?.verdict === r.verdict);
console.log(agree ? `regrade agrees with the manifest on all ${results.length} attempt(s)` : 'regrade DISAGREES with the manifest');
if (sign) {
  // The grader key: a persistent secret (LEGATE_GRADER_SEED), or an ephemeral key held by this process alone (--keys
  // ephemeral, the default in an attested job without a seed: the regrade's provenance is what binds it), or the demo key.
  const keysMode = flag('--keys', process.env.LEGATE_ATTEST === 'github-actions-provenance' && !process.env.LEGATE_GRADER_SEED ? 'ephemeral' : 'seed');
  const graderName = process.env.LEGATE_GRADER_NAME || (process.env.LEGATE_GRADER_SEED ? 'ScopeBlind verified-runs grader' : keysMode === 'ephemeral' ? 'Grader (ephemeral, held by the workflow run)' : 'Legate regrader (demo)');
  const grader = process.env.LEGATE_GRADER_SEED ? m.runSignerFromPrivate(Buffer.from(process.env.LEGATE_GRADER_SEED.trim(), 'hex'), graderName) : keysMode === 'ephemeral' ? m.runSignerFromPrivate(randomBytes(32), graderName) : m.runSignerFromSeed('legate-regrader', graderName);
  const ci = process.env.GITHUB_ACTIONS && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const regrade = m.createRunRegrade({ manifest, results, environment: { sandbox: ci ? `GitHub Actions runner (${process.platform}), separate job` : `developer machine (${process.platform})`, note: ci ? `Second grading in ${ci}; the tests were obtained ${sealedPath ? 'from the sealed archive' : 'from the benchmark repository at the pinned commit'} and checked against the pin.` : `Second grading on a developer machine; the tests were obtained ${sealedPath ? 'from the sealed archive' : 'from the benchmark repository at the pinned commit'} and checked against the pin.` } }, grader, new Date());
  writeFileSync(outPath, `${JSON.stringify(regrade, null, 2)}\n`);
  console.log(`signed regrade written to ${outPath} (grader ${grader.key_id})`);
}
process.exitCode = agree ? 0 : 1;
