# OSL A/B Test - 2026-06-04 (8 Worker, Low Concurrency)

## Setup

- Model: Qwen3-VL-8B-Instruct (TP1)
- Workers: 8 (one per GPU)
- Router: KV router (--router-mode kv) with --kv-events-config on each worker
- Trace: 50 requests from 1 session (sequential multi-turn), fixed-schedule replay
- Avg ISL: ~47K tokens
- Avg OSL: 39-57 tokens
- Infrastructure: NVIDIA H20 x 8, ZMQ event plane

## Key Finding: --kv-events-config Required

Without --kv-events-config on workers, KV hit rate = 0% and router degrades to round-robin.

Worker must include:
  --kv-events-config '{"publisher":"zmq","topic":"kv-events","endpoint":"tcp://*:5557"}'
(different ZMQ port per worker)

## Key Finding: router_track_output_blocks defaults to false

The OSL decay mechanism (decay_fraction = 1 - cumulative_osl / expected_osl) only runs when
router_track_output_blocks = true. Default is false, so osl hint has NO effect on scheduling
in the default configuration.

## Results

| Metric                      | A (no_hints) | B (with_osl) |  Diff |
|-----------------------------|-------------|-------------|-------|
| TTFT avg (ms)               |       539.4 |       772.8 | +43.3% |
| TTFT p50 (ms)               |       348.3 |       358.0 |  +2.8% |
| TTFT p90 (ms)               |       374.4 |       390.5 |  +4.3% |
| TTFT p99 (ms)               |      5924.4 |     11264.7 | +90.1% |
| ITL avg (ms)                |         9.3 |         9.4 |  +0.1% |
| E2E latency avg (ms)        |       910.7 |      1328.9 | +45.9% |
| E2E latency p50 (ms)        |       429.2 |       432.3 |  +0.7% |
| E2E latency p90 (ms)        |       740.9 |       763.0 |  +3.0% |
| Output throughput (tok/s)    |         3.5 |         4.9 | +41.8% |
| Total token throughput       |      4225.7 |      4142.3 |  -2.0% |
| Prefill tput/user (tok/s)   |    132591.5 |    131390.3 |  -0.9% |

## Analysis

No meaningful difference - as expected because:
1. router_track_output_blocks is OFF by default, so OSL hint is not used for scheduling
2. Single session, serial requests - no resource contention
3. 8 workers for 50 sequential requests = vastly over-provisioned
4. Short OSL (avg 39-57 tokens) - output blocks are negligible

## What is Needed for Meaningful OSL Testing

1. Enable --router-track-output-blocks on frontend
2. High concurrency (multiple sessions, 10x+ replay speedup)
3. Longer output sequences (OSL > 500)
4. Fewer workers (2-4) to create resource pressure

## Additional Notes

- ZMQ event plane does NOT support --router-reset-states (silently ignored)
- Must restart workers + frontend between A/B to ensure clean cache state
- KV hit rate with --kv-events-config: ~55-85% for same-session multi-turn
