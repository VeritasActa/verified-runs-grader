#!/usr/bin/env node
/**
 * Check a grading made here the way a reader would, with the vendored verifier:
 * the regrade verifies under its grader key and is for this run's manifest; its
 * provenance bundle is beside it and names its exact bytes; it agrees with the
 * manifest on every verdict and workspace; and, when the run's standard names
 * this repository as a grader, the whole grading reconciles.
 *
 *   node harness/check-regrade.mjs <run dir> <regrade dir>
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(resolve(here, '../verify/legate-run.core.mjs')).href);
const [runDir, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!runDir || !outDir) { console.error('usage: check-regrade.mjs <run dir> <regrade dir>'); process.exit(2); }
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const manifest = json(join(runDir, 'manifest.json'));
const standard = json(join(runDir, 'standard.json'));
const receipts = lines(join(runDir, 'receipts.jsonl'));
const bytes = readFileSync(join(outDir, 'regrade.json'));
const regrade = JSON.parse(bytes.toString('utf8'));
const bundleFile = join(outDir, 'regrade.json.sigstore.jsonl');
const bundles = existsSync(bundleFile) ? lines(bundleFile) : [];

const v = m.verifyRunManifest(manifest, { standard, receipts, regrades: [{ regrade, bytes, bundles }] });
const check = v.checks.find((c) => c.id === 'regrade');
const self = `https://github.com/${process.env.GITHUB_REPOSITORY ?? 'VeritasActa/verified-runs-grader'}`.toLowerCase();
const accepted = (standard.trust?.accepted_grader_provenance ?? []).some((g) => g.kind === 'github-actions-provenance' && g.repository.toLowerCase() === self);
const agrees = manifest.attempts.every((t) => regrade.results.some((r) => r.task_id === t.task_id && r.attempt === t.attempt && r.verdict === t.verdict && (!t.workspace || r.workspace_digest === t.workspace.digest)));

console.log(`run ${manifest.run_id}, grader ${regrade.grader?.key_id ?? '?'} (${regrade.grader?.name ?? '?'})`);
console.log(`  ${check?.ok ? 'holds' : 'does not hold'}: ${check?.detail ?? 'no regrade check in the result'}`);
console.log(accepted ? `  the run's standard names ${self} as a grader by provenance` : `  the run's standard does not name ${self} as a grader; this grading is a third word from a party the standard did not choose, and a reader weighs it as such`);
assert.equal(regrade.manifest_digest, manifest.digest, 'the regrade is for this manifest');
assert.ok(bundles.length > 0, 'the provenance bundle is beside the regrade (regrade.json.sigstore.jsonl)');
assert.ok(agrees, 'the grading agrees with the manifest on every verdict and workspace');
if (accepted) assert.ok(check?.ok, `the standard accepts this grader and the grading reconciles: ${check?.detail}`);
else assert.ok(check && (check.ok || check.detail.startsWith('The grader key is not one the standard accepts')), `the grading holds, or acceptance is the only reason it does not: ${check?.detail}`);
console.log('check-regrade: ok');
