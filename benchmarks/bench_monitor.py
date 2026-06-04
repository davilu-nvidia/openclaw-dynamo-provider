#!/usr/bin/env python3
"""Dynamo Benchmark Real-time Monitor with A/B comparison - port 9090"""

import json
import re
import subprocess
import urllib.request
import os
from flask import Flask, jsonify, Response, request as flask_request

app = Flask(__name__)

METRICS_URL = "http://127.0.0.1:8000/metrics"
SNAPSHOT_FILE = "/root/davilu/bench_snapshot.json"

def fetch_metrics():
    try:
        with urllib.request.urlopen(METRICS_URL, timeout=3) as r:
            return r.read().decode()
    except:
        return ""

def parse_prometheus(text):
    result = {}
    for line in text.split('\n'):
        if line.startswith('#') or not line.strip():
            continue
        m = re.match(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+(.+)$', line)
        if m:
            name, labels, value = m.group(1), m.group(2), m.group(3)
            try:
                value = float(value)
            except:
                pass
            if name not in result:
                result[name] = []
            result[name].append({"labels": labels, "value": value})
    return result

def get_frontend_logs():
    try:
        out = subprocess.check_output(
            ["docker", "logs", "dynamo-frontend", "--tail", "10000"],
            stderr=subprocess.STDOUT, timeout=10
        ).decode(errors='replace')
        # Only return logs after the last "KV Routing initialized" (latest frontend start)
        marker = "KV Routing initialized"
        idx = out.rfind(marker)
        if idx != -1:
            return out[idx:]
        return out
    except:
        return ""

def parse_requests(logs):
    ansi_re = re.compile(r'\x1b\[[0-9;]*m')
    requests = []
    for line in logs.split('\n'):
        if 'request completed' not in line:
            continue
        line = ansi_re.sub('', line)
        req = {}
        for pattern, key in [
            (r'input_tokens=(\d+)', 'isl'),
            (r'output_tokens=(\d+)', 'osl'),
            (r'ttft_ms="([0-9.]+)"', 'ttft_ms'),
            (r'avg_itl_ms="([0-9.]+)"', 'itl_ms'),
            (r'elapsed_ms=(\d+)', 'elapsed_ms'),
            (r'prefill_worker_id=(\d+)', 'prefill_worker'),
            (r'decode_worker_id=(\d+)', 'decode_worker'),
            (r'status=(\w+)', 'status'),
        ]:
            m = re.search(pattern, line)
            if m:
                v = m.group(1)
                if key in ('isl', 'osl', 'elapsed_ms'):
                    v = int(v)
                elif key in ('ttft_ms', 'itl_ms'):
                    v = float(v)
                req[key] = v
        if req:
            requests.append(req)
    return requests

def compute_stats(reqs):
    if not reqs:
        return {}
    ttfts = sorted([r['ttft_ms'] for r in reqs if 'ttft_ms' in r])
    itls = sorted([r['itl_ms'] for r in reqs if 'itl_ms' in r])
    e2es = sorted([r['elapsed_ms'] for r in reqs if 'elapsed_ms' in r])
    osls = [r['osl'] for r in reqs if 'osl' in r]
    isls = [r['isl'] for r in reqs if 'isl' in r]
    def pct(arr, p):
        if not arr: return 0
        idx = int(len(arr) * p / 100)
        return arr[min(idx, len(arr)-1)]
    def avg(arr):
        return sum(arr)/len(arr) if arr else 0
    workers = {}
    for r in reqs:
        w = (r.get('prefill_worker') or '?')[-4:]
        workers[w] = workers.get(w, 0) + 1
    return {
        "count": len(reqs),
        "ttft_avg": avg(ttfts), "ttft_p50": pct(ttfts, 50), "ttft_p90": pct(ttfts, 90), "ttft_p99": pct(ttfts, 99),
        "itl_avg": avg(itls), "itl_p50": pct(itls, 50), "itl_p90": pct(itls, 90),
        "e2e_avg": avg(e2es), "e2e_p50": pct(e2es, 50), "e2e_p90": pct(e2es, 90),
        "osl_avg": avg(osls), "isl_avg": avg(isls),
        "throughput_tok_s": sum(osls) / (max(e2es)/1000) if e2es else 0,
        "workers": workers,
    }

@app.route('/api/metrics')
def api_metrics():
    raw = fetch_metrics()
    parsed = parse_prometheus(raw)
    summary = {"queued_requests": 0, "kv_hit_rate": 0, "total_requests": 0, "ttft_avg_ms": 0}
    for item in parsed.get("dynamo_frontend_queued_requests", []):
        summary["queued_requests"] = item["value"]
    hit_sum = sum(i["value"] for i in parsed.get("dynamo_component_router_kv_hit_rate_sum", []))
    hit_cnt = sum(i["value"] for i in parsed.get("dynamo_component_router_kv_hit_rate_count", []))
    summary["kv_hit_rate"] = hit_sum / hit_cnt if hit_cnt > 0 else 0
    for item in parsed.get("dynamo_component_router_requests_total", []):
        summary["total_requests"] = item["value"]
    ttft_sum = sum(i["value"] for i in parsed.get("dynamo_component_router_time_to_first_token_seconds_sum", []))
    ttft_cnt = sum(i["value"] for i in parsed.get("dynamo_component_router_time_to_first_token_seconds_count", []))
    summary["ttft_avg_ms"] = (ttft_sum / ttft_cnt) * 1000 if ttft_cnt > 0 else 0
    return jsonify(summary)

@app.route('/api/requests')
def api_requests():
    logs = get_frontend_logs()
    reqs = parse_requests(logs)
    return jsonify(reqs)

@app.route('/api/stats')
def api_stats():
    logs = get_frontend_logs()
    reqs = parse_requests(logs)
    return jsonify(compute_stats(reqs))

@app.route('/api/snapshot', methods=['POST'])
def save_snapshot():
    logs = get_frontend_logs()
    reqs = parse_requests(logs)
    stats = compute_stats(reqs)
    label = flask_request.json.get('label', 'A') if flask_request.json else 'A'
    snapshot = {"label": label, "stats": stats, "requests": reqs}
    with open(SNAPSHOT_FILE, 'w') as f:
        json.dump(snapshot, f)
    return jsonify({"ok": True, "label": label, "count": stats["count"]})

@app.route('/api/snapshot', methods=['GET'])
def get_snapshot():
    if os.path.exists(SNAPSHOT_FILE):
        with open(SNAPSHOT_FILE) as f:
            return jsonify(json.load(f))
    return jsonify(None)

@app.route('/api/snapshot', methods=['DELETE'])
def delete_snapshot():
    if os.path.exists(SNAPSHOT_FILE):
        os.remove(SNAPSHOT_FILE)
    return jsonify({"ok": True})

@app.route('/api/status')
def api_status():
    try:
        out = subprocess.check_output(["pgrep", "-f", "aiperf"], timeout=3).decode()
        running = len(out.strip().split('\n')) > 0
    except:
        running = False
    logs = get_frontend_logs()
    completed = logs.count('request completed')
    return jsonify({"aiperf_running": running, "completed_requests": completed})

@app.route('/')
def index():
    return Response(DASHBOARD_HTML, content_type='text/html')

DASHBOARD_HTML = r'''<!DOCTYPE html>
<html>
<head>
<title>Dynamo Bench A/B Monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body { font-family: monospace; background: #1a1a2e; color: #eee; margin: 0; padding: 16px; }
.top { display: flex; gap: 24px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
.stat { text-align: center; }
.stat .value { font-size: 24px; font-weight: bold; color: #76b900; }
.stat .label { font-size: 11px; color: #888; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.card { background: #16213e; border-radius: 8px; padding: 16px; }
.full { grid-column: span 2; }
h3 { color: #76b900; margin: 0 0 12px 0; font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 4px 8px; text-align: right; border-bottom: 1px solid #333; }
th { color: #76b900; }
.better { color: #4caf50 !important; }
.worse { color: #f44336 !important; }
btn { background: #76b900; color: #000; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; font-family: monospace; }
btn:hover { background: #8fd400; }
btn.danger { background: #f44336; color: #fff; }
#status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.running { background: #4caf50; animation: pulse 1s infinite; }
.stopped { background: #666; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
canvas { max-height: 180px; }
.req-scroll { max-height: 350px; overflow-y: auto; }
.worker-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.worker-label { text-align: center; font-size: 12px; color: #888; margin-bottom: 4px; }
</style>
</head>
<body>
<div class="top">
  <div><span id="status-dot" class="stopped"></span> <span id="status-text">...</span></div>
  <div class="stat"><div class="value" id="completed">-</div><div class="label">Completed</div></div>
  <div class="stat"><div class="value" id="queued">-</div><div class="label">Queued</div></div>
  <div class="stat"><div class="value" id="kv-hit">-</div><div class="label">KV Hit%</div></div>
  <div class="stat"><div class="value" id="avg-ttft">-</div><div class="label">TTFT avg(ms)</div></div>
  <btn onclick="saveSnapshot()">Save as A</btn>
  <btn class="danger" onclick="clearSnapshot()">Clear A</btn>
</div>
<div class="grid">
  <div class="card">
    <h3>A/B Comparison</h3>
    <table class="ab-table">
      <thead><tr><th>Metric</th><th>A (saved)</th><th>B (live)</th><th>Diff</th></tr></thead>
      <tbody id="ab-table"></tbody>
    </table>
  </div>
  <div class="card">
    <h3>Worker Distribution</h3>
    <div class="worker-grid">
      <div><div class="worker-label" id="worker-label-a">A (saved)</div><canvas id="workerChartA"></canvas></div>
      <div><div class="worker-label" id="worker-label-b">Current</div><canvas id="workerChartB"></canvas></div>
    </div>
  </div>
  <div class="card">
    <h3>TTFT per Request (ms) - A(green) vs B(blue)</h3>
    <canvas id="ttftChart"></canvas>
  </div>
  <div class="card">
    <h3>ITL per Request (ms) - A(green) vs B(blue)</h3>
    <canvas id="itlChart"></canvas>
  </div>
  <div class="card full req-scroll">
    <h3>Per-Request Details (latest first)</h3>
    <table>
      <thead><tr><th>#</th><th>ISL</th><th>OSL</th><th>TTFT</th><th>ITL</th><th>E2E</th><th>Worker</th></tr></thead>
      <tbody id="req-table"></tbody>
    </table>
  </div>
</div>
<script>
let snapshotData = null;
const COLORS = ['#76b900','#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff','#ff9f40','#c9cbcf'];

const ttftChart = new Chart(document.getElementById('ttftChart').getContext('2d'), {
  type:'bar', data:{labels:[],datasets:[
    {label:'A',data:[],backgroundColor:'rgba(118,185,0,0.6)'},
    {label:'Current',data:[],backgroundColor:'rgba(54,162,235,0.6)'}
  ]},
  options:{responsive:true,scales:{y:{beginAtZero:true}},plugins:{legend:{display:true,labels:{boxWidth:10}}}}
});
const itlChart = new Chart(document.getElementById('itlChart').getContext('2d'), {
  type:'bar', data:{labels:[],datasets:[
    {label:'A',data:[],backgroundColor:'rgba(118,185,0,0.6)'},
    {label:'Current',data:[],backgroundColor:'rgba(54,162,235,0.6)'}
  ]},
  options:{responsive:true,scales:{y:{beginAtZero:true}},plugins:{legend:{display:true,labels:{boxWidth:10}}}}
});
const workerChartA = new Chart(document.getElementById('workerChartA').getContext('2d'), {
  type:'doughnut', data:{labels:[],datasets:[{data:[],backgroundColor:COLORS}]},
  options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:10}}}}}
});
const workerChartB = new Chart(document.getElementById('workerChartB').getContext('2d'), {
  type:'doughnut', data:{labels:[],datasets:[{data:[],backgroundColor:COLORS}]},
  options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:10}}}}}
});

function diffClass(a, b, lowerBetter=true) {
  if (!a || !b) return '';
  const pct = (b - a) / a * 100;
  if (lowerBetter) return pct < -3 ? 'better' : pct > 3 ? 'worse' : '';
  return pct > 3 ? 'better' : pct < -3 ? 'worse' : '';
}
function fmtDiff(a, b) {
  if (!a || !b) return '-';
  const pct = ((b - a) / a * 100).toFixed(1);
  return (pct > 0 ? '+' : '') + pct + '%';
}

function renderAB(liveStats) {
  const tbody = document.getElementById('ab-table');
  if (!snapshotData) {
    tbody.innerHTML = '<tr><td colspan=4 style="color:#888;text-align:center">Click "Save as A" after A completes</td></tr>';
    // Hide A worker chart
    workerChartA.data.labels = [];
    workerChartA.data.datasets[0].data = [];
    workerChartA.update();
    return;
  }
  const a = snapshotData.stats;
  const b = liveStats;
  const rows = [
    ['Requests', a.count, b.count, false],
    ['TTFT avg (ms)', a.ttft_avg, b.ttft_avg, true],
    ['TTFT p50 (ms)', a.ttft_p50, b.ttft_p50, true],
    ['TTFT p90 (ms)', a.ttft_p90, b.ttft_p90, true],
    ['TTFT p99 (ms)', a.ttft_p99, b.ttft_p99, true],
    ['ITL avg (ms)', a.itl_avg, b.itl_avg, true],
    ['ITL p90 (ms)', a.itl_p90, b.itl_p90, true],
    ['E2E avg (ms)', a.e2e_avg, b.e2e_avg, true],
    ['E2E p50 (ms)', a.e2e_p50, b.e2e_p50, true],
    ['E2E p90 (ms)', a.e2e_p90, b.e2e_p90, true],
    ['Throughput (tok/s)', a.throughput_tok_s, b.throughput_tok_s, false],
    ['Avg OSL', a.osl_avg, b.osl_avg, false],
  ];
  tbody.innerHTML = rows.map(([label, av, bv, lower]) => {
    const cls = diffClass(av, bv, lower);
    return `<tr><td style="text-align:left">${label}</td><td>${typeof av==='number'?av.toFixed(1):av||'-'}</td><td>${typeof bv==='number'?bv.toFixed(1):bv||'-'}</td><td class="${cls}">${fmtDiff(av,bv)}</td></tr>`;
  }).join('');

  // A worker chart
  if (a.workers) {
    workerChartA.data.labels = Object.keys(a.workers);
    workerChartA.data.datasets[0].data = Object.values(a.workers);
    workerChartA.update();
  }
}

async function saveSnapshot() {
  const r = await fetch('/api/snapshot', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({label:'A'})});
  const d = await r.json();
  alert('Saved A snapshot: ' + d.count + ' requests');
  snapshotData = await (await fetch('/api/snapshot')).json();
}
async function clearSnapshot() {
  await fetch('/api/snapshot', {method:'DELETE'});
  snapshotData = null;
  document.getElementById('ab-table').innerHTML = '';
}

async function refresh() {
  try {
    const [status, metrics, reqs, stats] = await Promise.all([
      fetch('/api/status').then(r=>r.json()),
      fetch('/api/metrics').then(r=>r.json()),
      fetch('/api/requests').then(r=>r.json()),
      fetch('/api/stats').then(r=>r.json()),
    ]);
    document.getElementById('status-dot').className = status.aiperf_running ? 'running' : 'stopped';
    document.getElementById('status-text').textContent = status.aiperf_running ? 'RUNNING' : 'IDLE';
    document.getElementById('completed').textContent = reqs.length;
    document.getElementById('queued').textContent = metrics.queued_requests;
    document.getElementById('kv-hit').textContent = (metrics.kv_hit_rate*100).toFixed(1)+'%';
    document.getElementById('avg-ttft').textContent = metrics.ttft_avg_ms.toFixed(0);

    // TTFT/ITL charts with A/B overlay
    const maxLen = Math.max(reqs.length, snapshotData ? snapshotData.requests.length : 0);
    const labels = Array.from({length: maxLen}, (_,i) => i+1);
    ttftChart.data.labels = labels;
    itlChart.data.labels = labels;
    if (snapshotData && snapshotData.requests) {
      ttftChart.data.datasets[0].data = snapshotData.requests.map(r=>r.ttft_ms||0);
      itlChart.data.datasets[0].data = snapshotData.requests.map(r=>r.itl_ms||0);
    } else {
      ttftChart.data.datasets[0].data = [];
      itlChart.data.datasets[0].data = [];
    }
    ttftChart.data.datasets[1].data = reqs.map(r=>r.ttft_ms||0);
    itlChart.data.datasets[1].data = reqs.map(r=>r.itl_ms||0);
    ttftChart.update();
    itlChart.update();

    // B worker chart (live)
    const wcount = {};
    reqs.forEach(r=>{const w=(r.prefill_worker||'?').slice(-4);wcount[w]=(wcount[w]||0)+1;});
    workerChartB.data.labels = Object.keys(wcount);
    workerChartB.data.datasets[0].data = Object.values(wcount);
    workerChartB.update();

    document.getElementById('req-table').innerHTML = reqs.slice().reverse().map((r,i)=>
      `<tr><td>${reqs.length-i}</td><td>${r.isl||'-'}</td><td>${r.osl||'-'}</td><td>${(r.ttft_ms||0).toFixed(0)}</td><td>${(r.itl_ms||0).toFixed(1)}</td><td>${r.elapsed_ms||'-'}</td><td>...${(r.prefill_worker||'?').slice(-4)}</td></tr>`
    ).join('');

    renderAB(stats);
  } catch(e) { console.error(e); }
}

(async()=>{
  const snap = await fetch('/api/snapshot').then(r=>r.json());
  if (snap) snapshotData = snap;
  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>'''

if __name__ == '__main__':
    print("Bench A/B Monitor on http://0.0.0.0:9090")
    app.run(host='0.0.0.0', port=9090, debug=False)
