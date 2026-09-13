# PathAsk

English | [简体中文](README.md)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](REQUIREMENTS.md)
[![CI](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml)

> A conversational whole-slide-image (WSI) pathology agent — ask a question about an entire slide and get back a research-grade report with a traceable chain of evidence.

General-purpose models are weak at pathology-specific recognition, and domain models are hard to orchestrate into a chain of evidence. PathAsk addresses both: a multimodal agent built on [Pi-Agent](https://github.com/earendil-works/pi) for pathology reading, supporting conversational questioning over any WSI and traceable reports.

## Tools (the 10 registered by `createTools`)

| Tool | Purpose |
|---|---|
| `scan_overview` | Low-magnification overview: thumbnail + tissue mask + candidate grid |
| `detect_roi` | Pick candidate ROIs by score; returns a `region_ref` |
| `perceive` | Single "tile + batch VLM description" step |
| `verify_region` | Hypothesis-driven review: ask of a region "is X visible?", returning support / challenge / uncertain |
| `query_clinical` | Clinical information lookup |
| `query_knowledge` | Knowledge-base lookup |
| `retrieve_similar_case` | Similar-case retrieval |
| `analyze_evidence` | Decision layer: hand all evidence to the LLM for a case-level judgment |
| `counterfactual` | Counterfactual check: drop one piece of evidence and see whether the conclusion flips |
| `generate_report` | Wrap-up: produce the structured report |

## What the report looks like

The report is a plain-data `Report` object:

```ts
export interface Report {
  primary_diagnosis: string
  confidence: number
  differential: DifferentialDiagnosis[]        // diagnosis + evidence for + evidence against + confidence
  evidence_graph: EvidenceGraph                // { nodes: EvidenceNode[]; edges: EvidenceEdge[] }
  uncertainty?: Uncertainty                    // explicit "needs review" when evidence conflicts or is thin, not a disclaimer
}

export type EvidenceRelation = 'supports' | 'contradicts' | 'excludes' | 'refines'
```

Every evidence node carries a `source`: tool name, `coords` (`x/y/w/h` + magnification + score), `magnification`,
model name, and degradation flags (`stub` / `degenerate` / `fallback`) — flagged observations do not enter the vote.

## Quick Start

```bash
git clone --recurse-submodules https://github.com/Golden-Promise/pathask.git
cd pathask
npm install
cp .env.example .env      # fill in endpoints and keys as needed
npm run typecheck         # tsc --noEmit
npm run dev               # offline scripted loop
```

Environment requirements (Node version, Python / OpenSlide, model endpoints) are in [`REQUIREMENTS.md`](REQUIREMENTS.md).

### Running the WSI bridge

TypeScript cannot call OpenSlide (a Python library), so there is a thin FastAPI bridge:

```bash
pip install -r wsi-bridge/requirements.txt   # openslide-python / fastapi / uvicorn
python wsi-bridge/server.py                  # defaults to http://127.0.0.1:8787
```

The registry and the WSI files are not in this repository — bring your own slides and request access from the
corresponding data sources (see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).

## Model endpoints

| Role | Purpose | Default endpoint | Default model id | Env vars |
|---|---|---|---|---|
| Decision / orchestration LLM | Text-only: drives the loop + case-level judgment | local vLLM `http://127.0.0.1:8014/v1` | `qwen3-8b` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| Pathology VLM | Reads images: morphological description and review | local vLLM `http://127.0.0.1:8012/v1` | `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

Both are swappable OpenAI-compatible endpoints — a self-hosted vLLM, SiliconFlow, or any other hosted service.
The defaults are loopback placeholders (this repository carries no internal addresses); point them at your own
deployment.

## Documentation

| File | Contents |
|---|---|
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Runtime and deployment requirements (Node / Python / OpenSlide / model endpoints) |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Third-party code, data, and models used, with entry links |
| [`CHANGELOG.md`](CHANGELOG.md) | Change log |
| [`LICENSE`](LICENSE) | MIT |
