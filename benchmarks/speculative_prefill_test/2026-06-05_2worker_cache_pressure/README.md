# Speculative Prefill A/B Test - 2026-06-05 (2 Worker, Cache Pressure)

## Setup

- Model: Qwen3-VL-8B-Instruct (TP1)
- Workers: 2 (to create cache pressure - 177% utilization)
- Router: KV router (--router-mode kv)
- Trace: 90 requests from 30 sessions (3 turns each), all sessions start at t=0, turn interval 5s
- ignore_eos: true (strict OSL control)
- Avg ISL: ~46K tokens, Avg OSL: ~553 tokens
- Clean restart (workers + frontend) between A and B

## Why 2 Workers

With 2 workers, the total KV cache demand (2.59M tokens) exceeds per-worker
capacity (730K tokens) at 177% utilization. This forces cache eviction,
which is the scenario where speculative prefill should help.

With 8 workers (44% utilization), cache never evicts and speculative prefill
has no benefit (confirmed in prior experiment).

## Experiment

- A: No speculative_prefill (cache evicts between turns, next turn re-prefills from scratch)
- B: speculative_prefill=true (after each turn completes, immediately prefills next-turn
  prefix to keep it warm in cache before eviction)

## Results (87 requests completed each, 3 errors)

| Metric                      | A (no spec) | B (spec pf) |   Diff |
|-----------------------------|-------------|-------------|--------|
| TTFT avg (ms)               |      29,719 |      28,028 |  -5.7% |
| TTFT p50 (ms)               |      20,775 |      16,872 | -18.8% |
| TTFT p90 (ms)               |      60,465 |      59,863 |  -1.0% |
| TTFT p99 (ms)               |     115,648 |     106,295 |  -8.1% |
| ITL avg (ms)                |       2,458 |       2,597 |  +5.7% |
| ITL p50 (ms)                |       1,175 |       1,149 |  -2.2% |
| ITL p90 (ms)                |       5,170 |       6,359 | +23.0% |
| E2E avg (ms)                |     116,144 |     116,742 |  +0.5% |
| E2E p90 (ms)                |     191,472 |     217,322 | +13.5% |
| Output throughput (tok/s)   |        43.8 |        42.9 |  -2.0% |
| Duration (s)                |       1,100 |       1,122 |  +2.1% |

## Analysis

**TTFT improved significantly (p50 -19%, avg -6%)** - speculative prefill successfully
keeps prefix cache warm between turns, reducing re-prefill overhead.

**ITL worsened (p90 +23%)** - the speculative prefill requests consume GPU compute,
competing with ongoing decode for the same workers. This is the fundamental tradeoff.

**E2E roughly unchanged** - TTFT improvement offset by ITL degradation.

## How Speculative Prefill Works

1. Turn N completes -> frontend has full conversation (history + response)
2. Frontend renders next-turn prefix (history + response, without new user message)
3. Sends max_tokens=1 request to worker -> full prefill, KV cache populated
4. 5s later, turn N+1 arrives -> prefix already in radix cache, only new user msg needs prefill
5. Without spec prefill: between turns, other sessions evict this session's cache (LRU)
   -> turn N+1 must re-prefill entire context from scratch

## Key Finding

Speculative prefill is a TTFT-vs-ITL tradeoff:
- Helps TTFT when cache is under pressure (eviction happening)
- Hurts ITL because extra prefill requests compete for GPU
- No benefit when cache fits (8 workers, 44% utilization)
- Most beneficial for latency-sensitive agentic workloads where TTFT matters
  more than decode throughput (e.g., coding agents waiting for first response)

## Speculative Prefill Statistics

- 87 speculative prefills fired (one per completed request, except errors)
- Prefill sizes ranged from 56 to 167K tokens
