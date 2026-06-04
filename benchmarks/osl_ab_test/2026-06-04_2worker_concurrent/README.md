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
