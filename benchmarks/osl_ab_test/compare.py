#!/usr/bin/env python3
"""Compare A/B benchmark results."""
import json
import sys
from pathlib import Path

def get_metrics(path):
    results = []
    with open(path) as f:
        for line in f:
            results.append(json.loads(line))
    ttfts = sorted([r['metrics']['time_to_first_token']['value'] for r in results if 'time_to_first_token' in r['metrics']])
    itls = sorted([r['metrics']['inter_token_latency']['value'] for r in results if 'inter_token_latency' in r['metrics']])
    e2es = sorted([r['metrics']['request_latency']['value'] for r in results if 'request_latency' in r['metrics']])
    return {'n': len(results), 'ttft': ttfts, 'itl': itls, 'e2e': e2es}

def pct(data, p):
    return data[int(len(data) * p)]

def main():
    base = Path(__file__).parent
    a = get_metrics(base / 'results_A_no_hints.jsonl')
    b = get_metrics(base / 'results_B_with_osl.jsonl')
    n = min(len(a['ttft']), len(b['ttft']))

    print(f"Comparing {n} matched requests\n")
    print(f"{'Metric':<12} {'A (no hints)':>14} {'B (with OSL)':>14} {'Delta':>10}")
    print("=" * 55)
    
    metrics = [
        ("TTFT p50", lambda d: d['ttft'][n//2]),
        ("TTFT p90", lambda d: pct(d['ttft'][:n], 0.9)),
        ("TTFT avg", lambda d: sum(d['ttft'][:n])/n),
        ("ITL p50", lambda d: d['itl'][len(d['itl'])//2]),
        ("ITL p90", lambda d: pct(d['itl'], 0.9)),
        ("ITL avg", lambda d: sum(d['itl'])/len(d['itl'])),
        ("E2E p50", lambda d: d['e2e'][len(d['e2e'])//2]),
        ("E2E p90", lambda d: pct(d['e2e'], 0.9)),
        ("E2E avg", lambda d: sum(d['e2e'])/len(d['e2e'])),
    ]
    
    for name, fn in metrics:
        va, vb = fn(a), fn(b)
        delta = (vb - va) / va * 100 if va > 0 else 0
        label = "faster" if delta < 0 else "slower"
        print(f"{name:<12} {va:>12.0f}ms {vb:>12.0f}ms {delta:>+7.1f}% {label}")

if __name__ == "__main__":
    main()
