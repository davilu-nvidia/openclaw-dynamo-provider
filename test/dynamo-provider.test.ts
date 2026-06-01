// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
	buildDynamoAgentContext,
	buildDynamoAgentHints,
	buildDynamoHeaders,
	DynamoSubagentSession,
	mergeDynamoNvext,
} from "../src/dynamo-provider.js";

describe("buildDynamoAgentContext", () => {
	it("builds context with config values", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "openclaw_coding_agent",
			workflowId: "wf-1",
			programId: "prog-1",
			parentProgramId: "parent-prog",
		};
		const ctx = buildDynamoAgentContext(config);
		expect(ctx).toEqual({
			workflow_type_id: "openclaw_coding_agent",
			workflow_id: "wf-1",
			program_id: "prog-1",
			parent_program_id: "parent-prog",
		});
	});
	it("falls back to provided sessionId", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "openclaw_coding_agent",
		};
		const ctx = buildDynamoAgentContext(config, "fallback-session");
		expect(ctx.workflow_id).toBe("fallback-session");
		expect(ctx.program_id).toBe("fallback-session");
	});
});

describe("buildDynamoAgentHints", () => {
	it("returns undefined when no hints configured", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "test",
		};
		expect(buildDynamoAgentHints(config)).toBeUndefined();
	});
	it("builds hints from config", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "test",
			priority: 5,
			osl: 2048,
			speculativePrefill: true,
		};
		expect(buildDynamoAgentHints(config)).toEqual({
			priority: 5,
			osl: 2048,
			speculative_prefill: true,
		});
	});
	it("uses maxTokens as OSL fallback", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "test",
		};
		expect(buildDynamoAgentHints(config, 4096)).toEqual({ osl: 4096 });
	});
	it("config.osl takes precedence over maxTokens", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			workflowTypeId: "test",
			osl: 1024,
		};
		expect(buildDynamoAgentHints(config, 8192)).toEqual({ osl: 1024 });
	});
});

describe("mergeDynamoNvext", () => {
	it("injects all nvext fields", () => {
		const payload = { model: "test", messages: [] };
		const ctx = { workflow_type_id: "t", workflow_id: "w", program_id: "p" };
		const hints = { priority: 10, osl: 2048 };
		const sc = { session_id: "s1", action: "open" as const };
		const result = mergeDynamoNvext(payload, ctx, hints, sc) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		expect(nvext.agent_context).toEqual(ctx);
		expect(nvext.agent_hints).toEqual(hints);
		expect(nvext.session_control).toEqual(sc);
		expect(result.model).toBe("test");
	});
	it("preserves existing nvext fields", () => {
		const payload = { nvext: { custom: "value" } };
		const ctx = { workflow_type_id: "t", workflow_id: "w", program_id: "p" };
		const result = mergeDynamoNvext(payload, ctx) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		expect(nvext.custom).toBe("value");
		expect(nvext.agent_context).toBeDefined();
	});
	it("existing agent_context fields take precedence", () => {
		const payload = { nvext: { agent_context: { workflow_type_id: "override" } } };
		const ctx = { workflow_type_id: "default", workflow_id: "w", program_id: "p" };
		const result = mergeDynamoNvext(payload, ctx) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		const ac = nvext.agent_context as Record<string, unknown>;
		expect(ac.workflow_type_id).toBe("override");
	});
});

describe("buildDynamoHeaders", () => {
	it("adds x-request-id when missing", () => {
		const headers = buildDynamoHeaders({});
		expect(headers["x-request-id"]).toBeDefined();
	});
	it("preserves existing x-request-id", () => {
		const headers = buildDynamoHeaders({ "X-Request-Id": "existing" });
		expect(headers["X-Request-Id"]).toBe("existing");
		expect(headers["x-request-id"]).toBeUndefined();
	});
});

describe("DynamoSubagentSession", () => {
	it("emits open on first turn, then sticky", () => {
		const session = new DynamoSubagentSession({
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			sessionControlId: "run:agent:0",
			sessionTimeoutSecs: 600,
		});
		const first = session.controlForTurn();
		expect(first.action).toBe("open");
		expect(first.session_id).toBe("run:agent:0");
		expect(first.timeout).toBe(600);

		const second = session.controlForTurn();
		expect(second.action).toBeUndefined();
	});

	it("close sends a request and resets state", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const session = new DynamoSubagentSession({
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			sessionControlId: "run:agent:0",
		});
		session.modelId = "test-model";
		session.controlForTurn();

		const result = await session.close(mockFetch);
		expect(result).toBe(true);
		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.nvext.session_control.action).toBe("close");
	});

	it("close is idempotent", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const session = new DynamoSubagentSession({
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			sessionControlId: "run:agent:0",
		});
		expect(await session.close(mockFetch)).toBe(false);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
