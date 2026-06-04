# OSL A/B Test - 2026-06-04 (2 Worker, 4 Sessions Concurrent, Perfect Hint)

## Setup

- Model: Qwen3-VL-8B-Instruct (TP1)
- Workers: 2 (to create resource pressure)
- Router: KV router (--router-mode kv --router-track-output-blocks)
- Workers: --kv-events-config with ZMQ publisher
- Trace: 20 requests from 4 sessions (5 turns each), fixed-schedule concurrent replay
- ignore_eos: true (strict OSL control)
- Sessions: s0082_0001, s0012_0001, s0106_0001, s0103_0001
- Avg ISL: ~90K tokens, Avg OSL: ~456 tokens (includes some 2000+ token outputs)

## Experiment Design

- A: No osl hint (expected_output_tokens = None, decay disabled)
- B: Perfect osl hint (hint == actual output_length, ideal decay curve)
- Between A/B: restart all workers + frontend to clear KV cache and router state

## Results

| Metric                | A (no_hints) | B (perfect) |   Diff |
|-----------------------|-------------|-------------|--------|
| TTFT avg (ms)         |      19,108 |      20,389 |  +6.7% |
| TTFT p50 (ms)         |      14,440 |      13,556 |  -6.1% |
| TTFT p90 (ms)         |      35,614 |      31,594 | -11.3% |
| ITL avg (ms)          |        76.7 |        54.4 | -29.1% |
| ITL p50 (ms)          |        19.6 |        19.1 |  -2.7% |
| ITL p90 (ms)          |       140.3 |       148.4 |  +5.8% |
| E2E avg (ms)          |      31,998 |      34,698 |  +8.4% |
| E2E p50 (ms)          |      23,517 |      24,718 |  +5.1% |
| E2E p90 (ms)          |      67,735 |      63,545 |  -6.2% |
| Output throughput     |      34.8   |      29.5   | -15.3% |
| Duration (s)          |       262   |       310   | +18.0% |

## Analysis

With perfect osl hint and resource pressure (2 workers, 4 concurrent sessions):

- TTFT p90 improved 11% - router better predicts when worker is about to be free
- ITL avg improved 29% - less queueing behind long-running requests
- But E2E avg and throughput got worse - decay may cause router to over-eagerly
  route to a worker that is "almost done" but still busy, creating transient overload
- 20 samples is too few for statistical significance; noise is high

## Key Findings

1. router_track_output_blocks must be explicitly enabled (default false)
2. Decay formula: decay_fraction = 1 - (cumulative_osl / expected_osl)
   - No hint -> None -> no decay -> all output blocks weight 1.0
   - Perfect hint -> smooth decay from 1.0 to 0.0
3. Over-estimated hint (hint >> actual) -> degrades to no-hint behavior (harmless)
4. Under-estimated hint (hint << actual) -> harmful, router thinks worker is free
5. KV router uses prefix affinity: same session always routes to same worker
6. Under low concurrency, osl hint has no effect (no resource contention)

## Router Behavior Observed (A, from frontend logs)

All requests within a session route to the same worker (prefix cache affinity).
Logit score = number of overlapping prefix blocks.
4 sessions distributed across 2 workers (~60/40 split).

## Per-Request Routing Detail (Dynamo Worker IDs)

Only 2 actual dynamo workers. A used ...6112/6118, B used ...6167/6173.

### A (no hint) - session to dynamo worker:
- s0012_0001 (5 req): ALL -> ...6118
- s0106_0001 (5 req): ALL -> ...6112
- s0082_0001 (5 req): 4 -> ...6112, 1 -> ...6118
- s0103_0001 (5 req): 2 -> ...6118, 3 -> ...6112

### B (perfect hint) - session to dynamo worker:
- s0012_0001 (5 req): ALL -> ...6167
- s0106_0001 (5 req): 4 -> ...6167, 1 -> ...6173
- s0082_0001 (5 req): ALL -> ...6173
- s0103_0001 (5 req): 4 -> ...6167, 1 -> ...6173

### Conclusion on routing decisions:
- Prefix affinity (overlap score) completely dominates routing - same session sticks to same worker
- OSL hint did NOT change routing targets - the decay from output blocks is negligible vs overlap scores of 50K-200K
- Minor cross-worker routing (1-2 requests per session) happens on first request when both workers have logit=0
- OSL hint's real effect is on queue_threshold decisions, not on which worker is selected

### Per-request A vs B comparison (ms):
| # | session     |   ISL |  OSL | A_TTFT | A_E2E  | B_TTFT | B_E2E  |
|---|-------------|-------|------|--------|--------|--------|--------|
| 0 | s0012_0001  | 30935 |   17 |   7444 |   7631 |   7190 |   8040 |
| 1 | s0106_0001  | 40103 |   41 |  13173 |  13641 |  13379 |  13561 |
| 2 | s0082_0001  | 30293 |   71 |   5587 |  13893 |   8114 |  13783 |
| 3 | s0012_0001  | 63023 |  109 |  10168 |  11957 |  22162 |  23222 |
| 4 | s0103_0001  | 12955 | 2394 |   2165 |  34705 |  10148 |  26214 |
| 5 | s0106_0001  | 80512 |   61 |  14943 |  16475 |   9070 |  44359 |
| 6 | s0012_0001  | 95971 |  198 |  15150 |  17849 |   2066 |  53269 |
| 7 | s0106_0001  |121037 |  117 |  22122 |  24539 |  13732 |  14300 |
| 8 | s0082_0001  | 59742 | 2156 |   9053 |  70119 |  22107 |  39315 |
| 9 | s0012_0001  |129765 |  122 |  20497 |  22495 |  30782 |  34675 |
|10 | s0012_0001  |163675 |  112 |  25791 |  32091 |  17876 |  19894 |
|11 | s0082_0001  | 91728 |   44 |  13936 |  44142 |  21854 |  22867 |
|12 | s0106_0001  |161834 |  121 |  33936 |  37122 |  38895 |  45100 |
|13 | s0103_0001  | 30729 | 2381 |  26282 |  48387 |  20338 |  60286 |
|14 | s0082_0001  |122276 |  127 |  17744 |  59986 |  25666 |  28956 |
|15 | s0103_0001  | 50928 |   80 |  11072 |  14506 |  12314 |  92875 |
|16 | s0106_0001  |202860 |  880 |  50718 |  86649 |   5872 |   6652 |
|17 | s0103_0001  | 69134 |   17 |   6909 |   7086 |   6974 |   7152 |
|18 | s0103_0001  | 88511 |   17 |   9013 |   9215 | 110206 | 130195 |
|19 | s0082_0001  |152572 |   56 |  66456 |  67469 |   9024 |   9242 |
|AVG|             |       |      |  19108 |  31998 |  20389 |  34698 |

Variance is dominated by timing noise (which requests happen to collide),
not by osl hint effect. Need 200+ requests x multiple runs for significance.
