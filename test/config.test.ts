// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
	applySubagentBridge,
	computeSubagentSessionId,
	computeSubagentTrajectoryRewrite,
	normalizeDynamoBaseUrl,
	readDynamoConfig,
} from "../src/config.js";

describe("normalizeDynamoBaseUrl", () => {
	it("appends /v1 to bare origin", () => {
		expect(normalizeDynamoBaseUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
	});
	it("preserves existing /v1 path", () => {
		expect(normalizeDynamoBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
	});
	it("strips trailing slashes", () => {
		expect(normalizeDynamoBaseUrl("http://localhost:8000/v1/")).toBe("http://localhost:8000/v1");
	});
	it("uses default when undefined", () => {
		expect(normalizeDynamoBaseUrl(undefined)).toBe("http://127.0.0.1:8000/v1");
	});
});

describe("computeSubagentSessionId", () => {
	it("returns undefined outside a child process", () => {
		expect(computeSubagentSessionId({})).toBeUndefined();
	});
	it("computes id from PI_SUBAGENT_ vars", () => {
		const env = {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_RUN_ID: "run-abc",
			PI_SUBAGENT_CHILD_AGENT: "researcher",
			PI_SUBAGENT_CHILD_INDEX: "2",
		};
		expect(computeSubagentSessionId(env)).toBe("run-abc:researcher:2");
	});
	it("computes id from OPENCLAW_AGENT_ vars", () => {
		const env = {
			OPENCLAW_AGENT_CHILD: "1",
			OPENCLAW_AGENT_RUN_ID: "run-xyz",
			OPENCLAW_AGENT_CHILD_AGENT: "coder",
		};
		expect(computeSubagentSessionId(env)).toBe("run-xyz:coder:0");
	});
	it("returns undefined when identity is incomplete", () => {
		expect(computeSubagentSessionId({ PI_SUBAGENT_CHILD: "1" })).toBeUndefined();
	});
});

describe("computeSubagentTrajectoryRewrite", () => {
	it("returns null when no inherited trajectory", () => {
		const env = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_RUN_ID: "r", PI_SUBAGENT_CHILD_AGENT: "a" };
		expect(computeSubagentTrajectoryRewrite(env)).toBeNull();
	});
	it("rewrites inherited trajectory to parent", () => {
		const env = {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_RUN_ID: "r",
			PI_SUBAGENT_CHILD_AGENT: "a",
			PI_SUBAGENT_CHILD_INDEX: "0",
			DYN_AGENT_TRAJECTORY_ID: "parent-traj",
		};
		expect(computeSubagentTrajectoryRewrite(env)).toEqual({
			trajectoryId: "r:a:0",
			parentTrajectoryId: "parent-traj",
		});
	});
	it("skips when DYN_AGENT_PARENT_TRAJECTORY_ID already set", () => {
		const env = {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_RUN_ID: "r",
			PI_SUBAGENT_CHILD_AGENT: "a",
			DYN_AGENT_TRAJECTORY_ID: "parent-traj",
			DYN_AGENT_PARENT_TRAJECTORY_ID: "explicit-parent",
		};
		expect(computeSubagentTrajectoryRewrite(env)).toBeNull();
	});
});

describe("applySubagentBridge", () => {
	it("mutates env and returns true on rewrite", () => {
		const env: Record<string, string | undefined> = {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_RUN_ID: "r",
			PI_SUBAGENT_CHILD_AGENT: "a",
			PI_SUBAGENT_CHILD_INDEX: "0",
			DYN_AGENT_TRAJECTORY_ID: "parent-traj",
		};
		expect(applySubagentBridge(env as unknown as NodeJS.ProcessEnv)).toBe(true);
		expect(env.DYN_AGENT_TRAJECTORY_ID).toBe("r:a:0");
		expect(env.DYN_AGENT_PARENT_TRAJECTORY_ID).toBe("parent-traj");
	});
	it("is idempotent", () => {
		const env: Record<string, string | undefined> = {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_RUN_ID: "r",
			PI_SUBAGENT_CHILD_AGENT: "a",
			DYN_AGENT_TRAJECTORY_ID: "parent-traj",
		};
		applySubagentBridge(env as unknown as NodeJS.ProcessEnv);
		expect(applySubagentBridge(env as unknown as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("readDynamoConfig", () => {
	it("reads basic config from env", () => {
		const env = {
			DYNAMO_BASE_URL: "http://10.0.0.1:9000/v1",
			DYNAMO_API_KEY: "my-key",
			DYN_AGENT_TRACE: "1",
			DYN_AGENT_SESSION_TYPE_ID: "custom_agent",
		};
		const config = readDynamoConfig(env);
		expect(config.baseUrl).toBe("http://10.0.0.1:9000/v1");
		expect(config.apiKey).toBe("my-key");
		expect(config.traceEnabled).toBe(true);
		expect(config.sessionTypeId).toBe("custom_agent");
	});
	it("falls back to OPENAI_BASE_URL", () => {
		const config = readDynamoConfig({ OPENAI_BASE_URL: "http://alt:8000" });
		expect(config.baseUrl).toBe("http://alt:8000/v1");
	});
	it("uses defaults for empty env", () => {
		const config = readDynamoConfig({});
		expect(config.baseUrl).toBe("http://127.0.0.1:8000/v1");
		expect(config.apiKey).toBe("dynamo-local");
		expect(config.traceEnabled).toBe(false);
		expect(config.sessionTypeId).toBe("openclaw_coding_agent");
	});
});
