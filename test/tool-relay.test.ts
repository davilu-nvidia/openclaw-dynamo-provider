// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
	DynamoToolEventPublisher,
	DynamoToolEventRelay,
	getToolClass,
	getToolResultOutputBytes,
	readDynamoToolRelayConfig,
	type ToolEventSocket,
} from "../src/tool-relay.js";

describe("getToolClass", () => {
	it("extracts class from tool name", () => {
		expect(getToolClass("bash")).toBe("bash");
		expect(getToolClass("read---file")).toBe("read");
		expect(getToolClass("mcp/tool")).toBe("mcp");
		expect(getToolClass(undefined)).toBe("unknown");
		expect(getToolClass("")).toBe("unknown");
	});
});

describe("getToolResultOutputBytes", () => {
	it("computes byte length of text content", () => {
		const result = { content: [{ text: "hello" }] };
		expect(getToolResultOutputBytes(result)).toBe(5);
	});
	it("returns undefined for non-content results", () => {
		expect(getToolResultOutputBytes("plain string")).toBeUndefined();
		expect(getToolResultOutputBytes(null)).toBeUndefined();
	});
});

describe("readDynamoToolRelayConfig", () => {
	it("reads endpoint from env", () => {
		const config = readDynamoToolRelayConfig({
			DYN_AGENT_TOOL_EVENTS_ZMQ_ENDPOINT: "tcp://localhost:5555",
		});
		expect(config.endpoint).toBe("tcp://localhost:5555");
		expect(config.topic).toBe("agent-tool-events");
	});
	it("tries all endpoint aliases", () => {
		const config = readDynamoToolRelayConfig({
			DYN_AGENT_TRACE_TOOL_ZMQ_ENDPOINT: "tcp://alt:5555",
		});
		expect(config.endpoint).toBe("tcp://alt:5555");
	});
	it("returns no endpoint when env is empty", () => {
		const config = readDynamoToolRelayConfig({});
		expect(config.endpoint).toBeUndefined();
	});
});

function createMockSocket(): ToolEventSocket & { frames: Buffer[][] } {
	const socket: ToolEventSocket & { frames: Buffer[][] } = {
		frames: [],
		connect: vi.fn(),
		send: vi.fn(async (frames) => { socket.frames.push([...frames]); }),
		close: vi.fn(),
	};
	return socket;
}

describe("DynamoToolEventPublisher", () => {
	it("publishes a record via ZMQ", async () => {
		const socket = createMockSocket();
		const publisher = new DynamoToolEventPublisher(
			{ endpoint: "tcp://localhost:5555", topic: "test-topic", queueCapacity: 100 },
			() => socket,
		);
		await publisher.start();
		const record = {
			schema: "dynamo.agent.trace.v1" as const,
			event_type: "tool_start" as const,
			event_time_unix_ms: 1000,
			event_source: "harness" as const,
			agent_context: {
				session_type_id: "test",
				session_id: "s1",
				trajectory_id: "t1",
			},
			tool: {
				tool_call_id: "tc1",
				tool_class: "bash",
				started_at_unix_ms: 1000,
				status: "running" as const,
			},
		};
		expect(publisher.publish(record)).toBe(true);
		await publisher.flush();
		expect(socket.frames.length).toBe(1);
		expect(socket.frames[0][0].toString()).toBe("test-topic");
	});

	it("refuses when closed", () => {
		const socket = createMockSocket();
		const publisher = new DynamoToolEventPublisher(
			{ endpoint: "tcp://localhost:5555", topic: "t", queueCapacity: 100 },
			() => socket,
		);
		publisher.close();
		expect(publisher.publish({} as any)).toBe(false);
	});
});

describe("DynamoToolEventRelay", () => {
	it("tracks start/end and publishes both events", async () => {
		const socket = createMockSocket();
		const publisher = new DynamoToolEventPublisher(
			{ endpoint: "tcp://localhost:5555", topic: "t", queueCapacity: 100 },
			() => socket,
		);
		await publisher.start();

		const config = {
			baseUrl: "http://localhost:8000/v1",
			apiKey: "key",
			traceEnabled: true,
			sessionTypeId: "test",
			trajectoryId: "traj-1",
			sessionId: "sess-1",
		};
		let perfMs = 0;
		const relay = new DynamoToolEventRelay(
			config,
			publisher,
			"sess-1",
			() => 1000,
			() => { perfMs += 50; return perfMs; },
		);

		relay.handleToolExecutionStart({ toolCallId: "tc1", toolName: "bash", args: {} });
		relay.handleToolExecutionEnd({ toolCallId: "tc1", toolName: "bash", result: { content: [{ text: "ok" }] }, isError: false });
		await publisher.flush();

		expect(socket.frames.length).toBe(2);
	});
});
