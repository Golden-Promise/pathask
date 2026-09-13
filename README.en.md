# PathAsk

English | [简体中文](README.md)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](REQUIREMENTS.md)
[![CI](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Golden-Promise/pathask/actions/workflows/ci.yml)

> A conversational whole-slide-image (WSI) pathology agent — ask a question about an entire slide and get back a **research-grade report with a traceable chain of evidence**.

General-purpose models are weak at pathology-specific recognition, and domain models are hard to orchestrate into a chain of evidence. PathAsk addresses both: a multimodal agent built on [Pi-Agent](https://github.com/earendil-works/pi) for pathology reading, supporting conversational questioning over any WSI and traceable reports.

## Tools (the 10 registered by `createTools`)

| Tool | Purpose |
|---|---|
| `scan_overview` | Low-magnification overview: thumbnail + tissue mask + candidate grid |
| `detect_roi` | Pick candidate ROIs by score (default `blend` = nuclear density + tissue density); returns a `region_ref` |
| `perceive` | **Single "tile + batch VLM description" step**, replacing `inspect_region → describe_patch` and saving one agent round-trip |
| `verify_region` | Hypothesis-driven review: ask of a region "is X visible?", returning support / challenge / uncertain |
| `query_clinical` | Clinical information lookup |
| `query_knowledge` | Knowledge-base lookup |
| `retrieve_similar_case` | Similar-case retrieval (CONCH vector store) |
| `analyze_evidence` | **Decision layer**: hand all evidence to the LLM for a case-level judgment |
| `counterfactual` | Counterfactual check: drop one piece of evidence and see whether the conclusion flips |
| `generate_report` | Wrap-up: produce the structured report |

> `inspect_region` / `describe_patch` still exist in the source but are **no longer exposed to the agent** — they are
> called by `runner.ts`'s internal paths (hotspot loop, dual-magnification review) and by `perceive`.

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

Example (long lists trimmed):

```jsonc
{
  "primary_diagnosis": "腺样囊性癌",
  "confidence": 0.5,
  "differential": [
    {
      "diagnosis": "导管原位癌（DCIS）",
      "confidence": 0.65,
      "evidence_for": ["态（Patho-R1）：导管内见异型上皮，细胞核增大深"],
      "evidence_against": ["大深染、极性紊乱，局部见浸润性生长趋势"]
    },
    {
      "diagnosis": "浸润性导管癌（IDC）",
      "confidence": 0.65,
      "evidence_for": ["复核 r1 @40×：基底膜局部断裂，间质见异型细胞巢 →"],
      "evidence_against": []
    }
  ],
  "evidence_graph": {
    "nodes": [
      {
        "id": "ev-1",
        "type": "observation",
        "claim": "全览：低倍全览（1.25×）：组织覆盖 68%，可见 3 处导管结构紊乱、细胞密度升高区域（r1/r2/r3）。",
        "confidence": 0.6,
        "source": { "tool": "scan_overview", "magnification": 1.25 }
      },
      {
        "id": "ev-2",
        "type": "observation",
        "polarity": "against",
        "claim": "在 \"寻找导管异型增生与可疑浸润灶\" 引导下检测到 3 个候选 ROI，按异常分降序：r1(导管上皮异型增生, score=0.87)、r2(可疑浸润灶, score=0.72)、r3(反应性增生, score=0.31)",
        "confidence": 0.65,
        "source": { "tool": "detect_roi" }
      },
      {
        "id": "ev-3",
        "type": "observation",
        "claim": "区域 r1 在 20× 下切取 4 个 patch（首块 patch_r1_0）",
        "confidence": 0.65,
        "source": {
          "tool": "inspect_region",
          "magnification": 20,
          "coords": {
            "id": "r1", "slide_id": "slide_brca_001",
            "x": 1200, "y": 3400, "w": 1024, "h": 1024,
            "magnification": 20, "anomaly_score": 0.87, "label": "导管上皮异型增生"
          }
        }
      },
      {
        "id": "ev-6",
        "type": "observation",
        "claim": "patch patch_r1_0 形态（Patho-R1）：导管内见异型上皮，细胞核增大深染、极性紊乱，局部见浸润性生长趋势",
        "confidence": 0.75,
        "source": { "tool": "describe_patch", "magnification": 20, "model": "patho-r1-7b", "fallback": true }
      },
      // … 17 nodes omitted here; 23 in total (19 observation / 2 inference / 2 conclusion)
      {
        "id": "ev-22",
        "type": "inference",
        "claim": "综合推断：腺样囊性癌（基于 19 条证据（规则投票））",
        "confidence": 0.5,
        "source": { "tool": "analyze_evidence" }
      },
      {
        "id": "ev-23",
        "type": "conclusion",
        "claim": "诊断：腺样囊性癌",
        "confidence": 0.5,
        "source": { "tool": "analyze_evidence" }
      }
    ],
    "edges": [
      { "from": "ev-1", "to": "ev-19", "relation": "supports",    "strength": 0.6 },
      { "from": "ev-2", "to": "ev-19", "relation": "contradicts", "strength": 0.65 }
      // … 39 edges in total
    ]
  },
  "uncertainty": { "type": "evidence_conflict", "recommended_action": "verify_region" }
}
```

How to read it:

- The `claim` / `diagnosis` strings are Chinese: the sample is verbatim output, and the pipeline was driven with a
  Chinese-language prompt. The field names and the structure are language-independent.
- `differential[].evidence_for` holds **±12-character context excerpts around a matched phrase**
  (`evidenceExcerpt` in `analyzeEvidence.ts`), which is why they look truncated — that is by design, not lost text.
  It guarantees every excerpt really does contain a morphological keyword.
- `source.fallback: true` means this morphological description came from a **degraded template** rather than a real
  VLM. Such observations **do not enter the vote** — otherwise "model goes down → every patch becomes a bland
  template" would wash the conclusion toward benign.
- `confidence: 0.5` together with `uncertainty.type: "evidence_conflict"` means the evidence contradicts itself:
  the agent does not force a call, it explicitly recommends `verify_region`.

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

The registry and the WSI files are **not in this repository** — bring your own slides and request access from the
corresponding data sources (see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)).

## Model endpoints

| Role | Purpose | Default endpoint | Default model id | Env vars |
|---|---|---|---|---|
| **Decision / orchestration LLM** | Text-only: drives the loop + case-level judgment | local vLLM `http://127.0.0.1:8014/v1` | `qwen3-8b` | `PATHASK_LLM_BASE_URL` / `PATHASK_LLM_MODEL` |
| **Pathology VLM** | Reads images: morphological description and review | local vLLM `http://127.0.0.1:8012/v1` | `patho-r1-7b` | `VLLM_BASE_URL` / `VLLM_MODEL` |

**Both are swappable OpenAI-compatible endpoints** — a self-hosted vLLM, SiliconFlow, or any other hosted service.
The defaults are **loopback placeholders** (this repository carries no internal addresses); point them at your own
deployment.

## Documentation

| File | Contents |
|---|---|
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Runtime and deployment requirements (Node / Python / OpenSlide / model endpoints) |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Third-party code, data, and models used, with entry links |
| [`CHANGELOG.md`](CHANGELOG.md) | Change log |
| [`LICENSE`](LICENSE) | MIT |
