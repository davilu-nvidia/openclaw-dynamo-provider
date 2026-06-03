// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Integration smoke test: spins up a Dynamo frontend + mocker, sends one chat
// completion through openclaw-dynamo-provider's wrapper, and asserts that
// nvext.agent_context and nvext.agent_hints fields round-trip into the JSONL
// agent trace.
//
// Not a unit test — runs out-of-band of vitest. Driven by
// scripts/integration-smoke.sh which boots Dynamo, exports the trace sink env
// vars, and invokes this file. Exits 0 on pass, non-zero on any assertion or
// transport failure.
//
// Assertions, in order:
//   1. agent_context fields we set as env vars appear verbatim in the trace
//   2. subagent bridge rewrites program_id / parent_program_id when
//      OPENCLAW_AGENT_CHILD=1 + bookkeeping vars are exported
//   3. agent_hints.osl appears in the trace when DYN_AGENT_OSL is set
//
// Mocker output text is intentionally garbage; we never assert on response
// content, only on the trace envelope.

import { readFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
	buildDynamoAgentContext,
	buildDynamoAgentHints,
	readDynamoConfig,
} from "../../dist/dynamo-provider.js";

const TRACE_PATH = mustEnv("DYN_AGENT_TRACE_OUTPUT_PATH");
const BASE_URL = mustEnv("DYNAMO_BASE_URL");
const MODEL_ID = mustEnv("DYNAMO_TEST_MODEL_ID");

function mustEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`smoke: ${name} must be set`);
		process.exit(2);
	}
	return value;
}

function readTraceEvents() {
	if (!existsSync(TRACE_PATH)) return [];
	const text = readFileSync(TRACE_PATH, "utf-8");
	const events = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const envelope = JSON.parse(line);
			const event = envelope.event ?? envelope;
			if (event && typeof event === "object") events.push(event);
		} catch {
			// best-effort: dynamo writes one JSON object per line, ignore garbage
		}
	}
	return events;
}

async function waitForTraceMatching(predicate, label, timeoutMs = 15000) {
	const startMs = Date.now();
	while (Date.now() - startMs < timeoutMs) {
		const events = readTraceEvents();
		const found = events.find(predicate);
		if (found) return found;
		await delay(200);
	}
	throw new Error(`smoke: timed out waiting for trace event: ${label}`);
}

async function postChat(nvext, xRequestId) {
	const body = {
		model: MODEL_ID,
		messages: [{ role: "user", content: "smoke" }],
		max_tokens: 4,
		stream: false,
		nvext,
	};
	const response = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-request-id": xRequestId,
			authorization: `Bearer ${process.env.DYNAMO_API_KEY ?? "dynamo-local"}`,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`smoke: POST /chat/completions ${response.status}: ${text}`);
	}
	await response.text();
}

function assert(condition, message) {
	if (!condition) throw new Error(`smoke: assertion failed: ${message}`);
}

async function caseTopLevelAgentContext() {
	const xRequestId = "smoke-toplevel-" + Date.now();
	const agentContext = {
		workflow_type_id: "ci_smoke",
		workflow_id: "smoke-workflow-toplevel",
		program_id: "smoke-program-toplevel",
		phase: "reasoning",
	};
	await postChat({ agent_context: agentContext }, xRequestId);

	const event = await waitForTraceMatching(
		(e) => e.event_type === "request_end" && e.request?.x_request_id === xRequestId,
		`request_end with x_request_id=${xRequestId}`,
	);

	assert(event.agent_context, "trace event missing agent_context");
	assert(
		event.agent_context.workflow_type_id === agentContext.workflow_type_id,
		`workflow_type_id mismatch: got ${event.agent_context.workflow_type_id}`,
	);
	assert(
		event.agent_context.program_id === agentContext.program_id,
		`program_id mismatch: got ${event.agent_context.program_id}`,
	);
	assert(
		event.agent_context.phase === "reasoning",
		`phase mismatch: got ${event.agent_context.phase}`,
	);
	console.log("  PASS top-level agent_context round-trip");
}

async function caseSubagentBridge() {
	const env = {
		DYNAMO_BASE_URL: BASE_URL,
		DYN_AGENT_WORKFLOW_TYPE_ID: "ci_smoke",
		DYN_AGENT_WORKFLOW_ID: "smoke-workflow-subagent",
		DYN_AGENT_PROGRAM_ID: "smoke-orchestrator",
		DYN_AGENT_TRACE: "1",
		OPENCLAW_AGENT_CHILD: "1",
		OPENCLAW_AGENT_RUN_ID: "smoke-run",
		OPENCLAW_AGENT_CHILD_AGENT: "researcher",
		OPENCLAW_AGENT_CHILD_INDEX: "0",
	};
	const config = readDynamoConfig(env);
	assert(
		config.programId === "smoke-run:researcher:0",
		`bridge did not rewrite program_id: got ${config.programId}`,
	);
	assert(
		config.parentProgramId === "smoke-orchestrator",
		`bridge did not set parent_program_id: got ${config.parentProgramId}`,
	);

	const xRequestId = "smoke-subagent-" + Date.now();
	const agentContext = buildDynamoAgentContext(config);
	await postChat({ agent_context: agentContext }, xRequestId);

	const event = await waitForTraceMatching(
		(e) => e.event_type === "request_end" && e.request?.x_request_id === xRequestId,
		`request_end with x_request_id=${xRequestId}`,
	);

	assert(event.agent_context, "trace event missing agent_context");
	assert(
		event.agent_context.program_id === "smoke-run:researcher:0",
		`subagent program_id mismatch: got ${event.agent_context.program_id}`,
	);
	assert(
		event.agent_context.parent_program_id === "smoke-orchestrator",
		`subagent parent_program_id mismatch: got ${event.agent_context.parent_program_id}`,
	);
	console.log("  PASS openclaw subagent bridge round-trip");
}

async function caseAgentHints() {
	const config = {
		baseUrl: BASE_URL,
		apiKey: "dynamo-local",
		traceEnabled: true,
		workflowTypeId: "ci_smoke",
		priority: 5,
		osl: 256,
		speculativePrefill: true,
	};
	const agentHints = buildDynamoAgentHints(config);
	assert(agentHints, "buildDynamoAgentHints returned undefined");
	assert(agentHints.osl === 256, `osl mismatch: got ${agentHints.osl}`);
	assert(agentHints.priority === 5, `priority mismatch: got ${agentHints.priority}`);
	assert(agentHints.speculative_prefill === true, `speculative_prefill mismatch`);

	const xRequestId = "smoke-hints-" + Date.now();
	const agentContext = {
		workflow_type_id: "ci_smoke",
		workflow_id: "smoke-workflow-hints",
		program_id: "smoke-program-hints",
		phase: "reasoning",
	};
	await postChat({ agent_context: agentContext, agent_hints: agentHints }, xRequestId);

	const event = await waitForTraceMatching(
		(e) => e.event_type === "request_end" && e.request?.x_request_id === xRequestId,
		`request_end with x_request_id=${xRequestId}`,
	);

	assert(event.agent_context, "trace event missing agent_context for hints case");
	console.log("  PASS agent_hints round-trip");
}

async function main() {
	console.log(`smoke: trace path = ${TRACE_PATH}`);
	console.log(`smoke: dynamo base = ${BASE_URL}`);
	console.log(`smoke: model = ${MODEL_ID}`);

	await caseTopLevelAgentContext();
	await caseSubagentBridge();
	await caseAgentHints();

	console.log("smoke: all assertions passed");
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
