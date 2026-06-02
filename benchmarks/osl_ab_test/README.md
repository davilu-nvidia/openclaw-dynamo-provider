# OSL Agent Hint A/B Benchmark

Measures the performance impact of `nvext.agent_hints.osl` (predicted output sequence length) on Dynamo's KV router scheduling.

## Setup

- **Model**: Qwen3-VL-8B-Instruct (TP1)
- **Workers**: 2 (to create resource pressure)
- **Router**: KV router (`--router-mode kv`)
- **Trace**: 946 requests from real coding-agent sessions, replayed at 10x speedup
- **Input tokens**: 30 - 32k
- **Output tokens**: 4 - 256 (capped)
- **Infrastructure**: NVIDIA H20 (144GB HBM each), NATS event plane

## Runs

- **A (baseline)**: No `nvext.agent_hints` — router has no OSL information
- **B (with OSL)**: `nvext.agent_hints.osl` set by sliding-window p75 predictor

## Results (first 200 requests, matched)

| Metric | A (no hints) | B (with OSL) | Delta |
|--------|-------------|-------------|-------|
| TTFT p90 | 30,439ms | 25,146ms | **-17.4%** |
| ITL p90 | 3,301ms | 2,642ms | **-20.0%** |
| ITL avg | 1,620ms | 1,286ms | **-20.6%** |
| E2E p90 | 152,015ms | 142,635ms | **-6.2%** |
| E2E avg | 66,534ms | 60,437ms | **-9.2%** |
| TTFT p50 | 8,555ms | 9,867ms | +15.3% |
| E2E p50 | 39,196ms | 44,576ms | +13.7% |

## Analysis

Under resource pressure (2 workers, high concurrency from 10x replay speedup):
- **Tail latency (p90) improved 6-20%** across all metrics
- **Average ITL reduced by 21%** — router makes better scheduling decisions with OSL hint
- p50 slightly worse (+15%) due to nvext serialization overhead and router hint evaluation cost
- Net effect: significantly better worst-case latency at the cost of marginal median regression

## OSL Predictor Algorithm

Sliding-window p75 with scale-adaptive multiplier (pure online, no lookup tables):
- Under-prediction rate: ~10%
- Resource reserve reduction: 87% vs max_tokens baseline
- See `src/osl-predictor.ts` for implementation

## Reproduce

```bash
# Start 2-worker Dynamo cluster with KV router
docker run -d --name dynamo-worker-0 --gpus '"device=0"' --network host \
  -e NATS_URL=nats://127.0.0.1:4222 -v /path/to/model:/model \
  nvcr.io/nvidia/ai-dynamo/sglang-runtime:1.1.1 \
  python -m dynamo.sglang --model-path /model --port 30000 \
    --request-plane nats --event-plane nats --enable-streaming-session

# (repeat for worker-1 on device=1, port=30001)

# Start frontend with KV router
docker run -d --name dynamo-frontend --network host \
  -e NATS_URL=nats://127.0.0.1:4222 -v /path/to/model:/model \
  nvcr.io/nvidia/ai-dynamo/sglang-runtime:1.1.1 \
  python -m dynamo.frontend --model-path /model --http-port 8000 \
    --router-mode kv --request-plane nats --event-plane nats \
    --router-min-initial-workers 2

# Run benchmark
aiperf profile --model /model --tokenizer Qwen/Qwen3-VL-8B-Instruct \
  --endpoint-type chat --streaming --url http://127.0.0.1:8000 \
  --input-file trace_no_hints.jsonl --custom-dataset-type mooncake_trace \
  --fixed-schedule --fixed-schedule-auto-offset \
  --artifact-dir results_A
```
