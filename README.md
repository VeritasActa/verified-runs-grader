# verified-runs-grader

A second opinion on a verified run, from outside the repository that made it.

[ScopeBlind/verified-runs](https://github.com/ScopeBlind/verified-runs) publishes runs of agentic benchmarks in which every tool call went through a gateway under a signed standard, the harness graded the result, and the harness's account is signed. Each run there is graded twice: by the harness, and again by a separate job in the same repository. This repository grades a run a third time, from a different repository, under a different organization, in its own workflow on its own runner, under a key that the workflow run generates, uses once, and discards.

What makes that grading count is not the key. It is the provenance: GitHub attests the bytes of the grading to this repository, this workflow, and this run, and a standard that names this repository under `trust.accepted_grader_provenance` accepts a grading whose bundle carries that identity. The grader needs no key listed in advance, and the maintainer of the runs cannot make one of these gradings, because the maintainer cannot make this repository's workflow sign anything.

## Making one

```
gh workflow run regrade.yml -R VeritasActa/verified-runs-grader -f run=runs/<name>
```

The workflow checks out the run from the runs repository at the ref given, rebuilds each task's workspace from the archive the manifest pins (refusing any file whose digest differs), obtains the pinned tests from the benchmark at the pinned revision (or from a sealed archive, for a sealed task set, with `SEALED_TASKS_KEY`), checks every test file against the pin, runs the tests, and compares the verdicts with the manifest's. With every verdict in hand it signs `regrade.json`, attests it, and keeps the attestation bundle beside it as `regrade.json.sigstore.jsonl`. Both are the workflow's artifact. A grading that disagrees with the manifest is written, attested, and kept all the same, and the job fails to say so.

## Reading one

The runs repository adopts a grading made here under `runs/<name>/regrades/veritasacta-verified-runs-grader/`. A reader checks it with the published verifier, giving the run's own grading first:

```
npx @veritasacta/verify manifest.json --standard standard.json --receipts receipts.jsonl --regrade regrade.json --regrade regrades/veritasacta-verified-runs-grader/regrade.json --provenance provenance --provenance regrades/veritasacta-verified-runs-grader
```

The verifier reports each grading: whether it verifies, whether the standard accepts its grader (by key, or by the provenance identity), which repository made it, and whether it agrees with every verdict and workspace. `gh attestation verify regrade.json --owner VeritasActa` is the independent path to the provenance.

## What this does and does not establish

It establishes that a party other than the one that made the run rebuilt the archived workspaces, ran the pinned tests, and got the verdicts the manifest states, and that the party's own account of that is bound to its workflow by provenance a reader verifies offline. It does not establish that the tests are good tests, that the task set is fair, or that the workspaces were made the way the manifest says (the run's own provenance and receipts speak to that).

One person administers both organizations today. What separates the two gradings is the repository, the workflow, the runner, and the key, each of which the provenance names, and none of which the runs repository's workflow can reach. A grading by a stranger is the next step, and this repository is the template for one: fork it, and the runs repository's standard can name your fork.

## Contents

- `harness/regrade.mjs`: the grading script, the same file the runs repository uses (`--keys ephemeral` signs under a key held by the workflow run alone; `LEGATE_GRADER_NAME` names the grader).
- `harness/check-regrade.mjs`: checks a grading the way a reader would, with the vendored verifier.
- `verify/legate-run.core.mjs`: the verifier, vendored unchanged; its digest is in `verify/README.md`.
- `.github/workflows/regrade.yml`: the workflow.
