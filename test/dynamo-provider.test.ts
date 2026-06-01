// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
	buildDynamoAgentContext,
	buildDynamoHeaders,
	DynamoSubagentSession,
	mergeDynamoAgentContext,
	mergeDynamoSessionControl,
} from "../src/dynamo-provider.js";

describe("buildDynamoAgentContext", () => {
	it("builds context with config values", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			sessionTypeId: "openclaw_coding_agent",
			trajectoryId: "traj-1",
			sessionId: "sess-1",
			parentTrajectoryId: "parent-traj",
		};
		const ctx = buildDynamoAgentContext(config);
		expect(ctx).toEqual({
			trajectory_id: "traj-1",
			parent_trajectory_id: "parent-traj",
			session_id: "sess-1",
			session_type_id: "openclaw_coding_agent",
			phase: "reasoning",
		});
	});
	it("falls back to provided sessionId", () => {
		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			sessionTypeId: "openclaw_coding_agent",
		};
		const ctx = buildDynamoAgentContext(config, "fallback-session");
		expect(ctx.trajectory_id).toBe("fallback-session");
		expect(ctx.session_id).toBe("fallback-session");
	});
});

describe("mergeDynamoAgentContext", () => {
	it("injects nvext.agent_context into payload", () => {
		const payload = { model: "test", messages: [] };
		const ctx = { session_type_id: "test", phase: "reasoning" as const };
		const result = mergeDynamoAgentContext(payload, ctx) as Record<string, unknown>;
		expect((result.nvext as Record<string, unknown>).agent_context).toEqual(ctx);
		expect(result.model).toBe("test");
	});
	it("preserves existing nvext fields", () => {
		const payload = { nvext: { custom: "value" } };
		const ctx = { session_type_id: "test", phase: "reasoning" as const };
		const result = mergeDynamoAgentContext(payload, ctx) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		expect(nvext.custom).toBe("value");
		expect(nvext.agent_context).toBeDefined();
	});
	it("existing agent_context fields take precedence", () => {
		const payload = { nvext: { agent_context: { session_type_id: "override" } } };
		const ctx = { session_type_id: "default", phase: "reasoning" as const };
		const result = mergeDynamoAgentContext(payload, ctx) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		const ac = nvext.agent_context as Record<string, unknown>;
		expect(ac.session_type_id).toBe("override");
	});
});

describe("mergeDynamoSessionControl", () => {
	it("injects nvext.session_control", () => {
		const payload = { model: "test" };
		const sc = { session_id: "s1", action: "open" as const };
		const result = mergeDynamoSessionControl(payload, sc) as Record<string, unknown>;
		const nvext = result.nvext as Record<string, unknown>;
		expect(nvext.session_control).toEqual(sc);
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
		expect(second.session_id).toBe("run:agent:0");
	});

	it("close sends a request and resets state", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const session = new DynamoSubagentSession({
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			sessionControlId: "run:agent:0",
		});
		session.modelId = "test-model";
		session.controlForTurn(); // open

		const result = await session.close(mockFetch);
		expect(result).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("http://localhost:8000/v1/chat/completions");
		const body = JSON.parse(init.body);
		expect(body.nvext.session_control.action).toBe("close");
	});

	it("close is idempotent", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		const session = new DynamoSubagentSession({
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			sessionControlId: "run:agent:0",
		});
		// Not opened: close should be a no-op
		expect(await session.close(mockFetch)).toBe(false);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
