# OSL A/B Test - 2026-06-04 (8 Worker, High Concurrency, Perfect Hint)

## Setup

- Model: Qwen3-VL-8B-Instruct (TP1)
- Workers: 8 (one per GPU, H20)
- Router: KV router (--router-mode kv --router-track-output-blocks)
- Workers: --kv-events-config with ZMQ publisher
- Trace: 90 requests from 30 sessions (3 turns each), all sessions start at t=0, turn interval 5s
- ignore_eos: true (strict OSL control)
- Avg ISL: ~45K tokens, Avg OSL: ~535 tokens
- Clean restart (workers + frontend) between A and B

## Experiment

- A: No osl hint (decay_fraction = None, output blocks weight = 1.0)
- B: Perfect osl hint (hint == actual output_length, smooth decay from 1.0 to 0.0)

## Results (90 requests each)

| Metric              | A (no hint) | B (perfect) |   Diff |
|---------------------|-------------|-------------|--------|
| TTFT avg (ms)       |      11,774 |      11,910 |  +1.2% |
| TTFT p50 (ms)       |       4,797 |       5,061 |  +5.5% |
| TTFT p90 (ms)       |      31,195 |      32,276 |  +3.5% |
| ITL avg (ms)        |         550 |         557 |  +1.2% |
| ITL p50 (ms)        |          24 |          44 | +82.2% |
| ITL p90 (ms)        |         958 |       1,558 | +62.6% |
| E2E avg (ms)        |      32,431 |      34,687 |  +7.0% |
| E2E p50 (ms)        |      13,330 |      18,021 | +35.2% |
| E2E p90 (ms)        |      83,716 |      84,426 |  +0.8% |
| Throughput (tok/s)   |       152.5 |       154.8 |  +1.5% |

## Conclusion: Perfect OSL Hint HURTS Performance

Decay causes router to prematurely route new requests to workers that are "almost done"
but still actively decoding. This creates GPU compute contention:

1. Decay fraction approaches 0 -> router thinks worker is nearly free
2. Router sends new request (large prefill) to that worker
3. Prefill preempts ongoing decode -> ITL spikes for existing requests
4. Net effect: more contention, worse latency across the board

Without hint (A): router sees full output block weight (1.0), stays conservative,
distributes load more evenly -> better performance.

## Root Cause

The decay mechanism assumes "fewer occupied blocks = more capacity". But in continuous
batching with GPU compute sharing, the bottleneck is NOT block occupancy but compute
bandwidth. A worker with 1 block remaining still uses 100% GPU for that decode step.
Decay misleads the router into thinking capacity is available when it isn't.

## Implications

- router_track_output_blocks should likely remain OFF (default) for aggregated serving
- OSL hint may only help in disaggregated prefill/decode where block occupancy directly
  maps to capacity (decode workers have fixed batch slots)
- Alternative: use osl hint for queue_threshold decisions only, not for overlap scoring
