# Evidence Pipeline: Contract and Evaluation Plan

This document describes the evidence extraction and conflict detection boundary shown in the Coze workflow diagram and defines a concrete target contract for improving it.

It separates **what the repository currently confirms** from **what should be implemented and measured next**. The Coze workflow graph itself is not exported in this repository, so node prompts, model settings, and thresholds cannot be independently verified here.

## 1. Module boundary

### Confirmed by the workflow diagram and application contract

The workflow has two input paths:

- `document_slicing`: parsed document chunks
- `kb_source`: knowledge base retrieval results

The paths feed a shared sequence:

1. fact extraction
2. normalization and deduplication
3. hard-rule conflict checks
4. semantic conflict judgment
5. conflict merge and statistics

The web application accepts `files`, `parsed_chunks`, and `kb_query` inputs for the C Module. The generation route reads evidence from `evidence_ledger` or `merged_evidences`, and conflicts from `conflict_register` or `conflicts`.

### Not committed in this repository yet

- Coze workflow export or node-level configuration
- prompts and model parameters
- normalization dictionaries and numeric tolerances
- labeled evaluation examples and measured quality metrics

Do not present these as implemented until the workflow configuration and evaluation results are versioned.

## 2. Evidence contract

An evidence item should represent one atomic, source-grounded claim.

| Field | Meaning | Validation |
|---|---|---|
| `evidence_id` | Stable identifier within a run | Unique, non-empty |
| `source_id` | Source document or knowledge item | Must resolve to a source |
| `chunk_id` | Parsed chunk containing the claim | Resolve when available |
| `subject` | Entity the claim is about | Canonicalize aliases without discarding source wording |
| `predicate` | Metric or relationship | Use a controlled vocabulary where possible |
| `object` | Textual object or claim value | Preserve the extracted meaning |
| `value`, `unit`, `currency` | Numeric value and units | Keep original quote; convert only with an explicit rule |
| `period` | Time period to which the claim applies | Do not equate adjacent periods |
| `scope` | Statistical or organizational scope | Keep distinctions such as consolidated vs. parent-only |
| `evidence_type` | Number, fact, forecast, opinion, policy, etc. | Separate forecast from reported result |
| `quote` | Supporting source excerpt | Must support the claim; do not paraphrase as a quote |
| `locator` | Page, section, table, paragraph, or quote hash | Preserve the best available location |
| `confidence` | Extraction confidence in `0, 1` | Calibrate against labeled examples |
| `source_authority` | Source reliability metadata | Keep separate from extraction confidence |

The current TypeScript contract is in `src/lib/types.ts`. Where the external workflow schema differs, normalize at the API boundary and document the mapping.

## 3. Normalization and deduplication

Normalization should make comparable facts comparable without erasing information needed to judge them.

### Recommended order

1. Preserve the source quote and original value.
2. Canonicalize entity aliases and metric names.
3. Parse number, unit, currency, and period into separate fields.
4. Normalize units only when conversion is unambiguous.
5. Retain scope, source, locator, and evidence type.
6. Group exact duplicates; merge provenance rather than dropping duplicate sources.
7. Consider semantic duplicates only inside compatible subject, predicate, period, and scope groups.

### Important non-equivalences

Do not merge or compare facts solely because their text or numbers look similar. For example:

- different reporting periods
- consolidated vs. parent-only figures
- actual result vs. forecast
- different currencies or unit scales
- preliminary vs. audited result
- gross vs. net values

These should remain distinguishable in the normalized representation.

## 4. Conflict detection

### Hard-rule checks

Use deterministic checks for structured numeric facts. A candidate pair should first match on canonical subject, metric, period, and scope. Then compare normalized values and units.

- Use metric-specific absolute or relative tolerances; avoid one global threshold.
- Record the compared fields and normalized values in the explanation.
- Treat incompatible or missing scopes as `needs_review`, not as a confirmed contradiction.
- Keep source authority as context for resolution, not as proof that the lower-authority value is false.

### Semantic judgment

The semantic stage should only receive candidate pairs that passed basic comparability checks. Its output should use a small closed set:

- `contradicts`
- `supports`
- `compatible`
- `insufficient_context`

Only `contradicts` should create a conflict. `insufficient_context` should be surfaced as a review item rather than silently promoted to a contradiction.

Each semantic decision should include:

- the two or more `evidence_ids`
- a short reason grounded in the quotes
- the dimensions compared (subject, metric, period, scope)
- a confidence score or explicit `needs_review` state

### Conflict record

A conflict should contain a stable `conflict_id`, `evidence_ids`, `conflict_type`, `severity`, `summary`, `explanation`, `resolved`, and an optional resolution suggestion. Every referenced evidence ID must exist in the same run.

Do not automatically discard one side of an unresolved conflict. The report should preserve both claims and explain the difference.

## 5. Output validation

Before returning a workflow result:

- validate JSON against a versioned schema
- reject duplicate IDs and dangling evidence references
- verify confidence ranges and allowed enum values
- ensure each quote has a source and, where available, a locator
- ensure every conflict has at least two distinct evidence IDs
- return an explicit empty result when no facts or conflicts are found
- return structured error details for malformed output or failed sources

The web application performs deterministic checks for cited evidence IDs, required headings, source status, and conflicts that reference missing evidence. These checks catch broken provenance links; they do not establish that a fact is true or that the model detected every contradiction. A successful workflow execution only indicates that the graph ran.

## 6. Evaluation plan

Build a small labeled set before tuning prompts or thresholds. Include examples for:

| Case | Expected behavior |
|---|---|
| Same fact repeated verbatim across sources | Deduplicate the claim and retain both source references |
| Same value with equivalent unit scales | Normalize and do not report a conflict |
| Same metric but different periods | Keep separate; no conflict |
| Same metric and period but different scope | Flag a scope difference for review |
| Actual result vs. forecast | Keep separate unless the workflow explicitly compares forecast error |
| Different values for same subject, metric, period, and scope | Emit a hard conflict with both evidence IDs |
| Textual claims that cannot both be true | Emit a semantic conflict with quote-grounded reasoning |
| Similar wording with compatible meaning | Do not emit a conflict |
| OCR-corrupted or incomplete evidence | Lower confidence or mark for review |
| No relevant evidence | Return an empty ledger and explain the coverage gap |

Report metrics separately:

- extraction precision, recall, and F1
- quote support rate and locator accuracy
- duplicate merge precision and recall
- conflict precision, recall, and F1 by conflict type
- provenance completeness
- latency and token cost per source

Do not publish a quality percentage until it is computed from a disclosed labeled set and a reproducible evaluation procedure.

## 7. Interview explanation

A precise explanation of the module is:

> I worked on the evidence extraction and conflict detection part of the reporting workflow. The workflow accepts parsed document chunks or knowledge-base results, extracts atomic claims, normalizes comparable fields while preserving source provenance, and then separates deterministic numeric checks from semantic contradiction checks. The output is an evidence ledger and a conflict register linked by IDs, so later report sections can cite both the claim and its source. The next engineering step is to version the Coze graph and evaluate extraction, deduplication, and conflict detection on a labeled set; without that evaluation, I would not claim a measured accuracy improvement.

If the exact Coze prompts or rule thresholds differ from this target design, describe what is currently configured and identify these recommendations as future work.
