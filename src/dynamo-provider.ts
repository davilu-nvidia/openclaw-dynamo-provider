// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
	DynamoAgentContext,
	DynamoProviderRuntimeConfig,
	DynamoSessionControl,
} from "./config.js";

export interface DynamoModelEntry {
	id: string;
	name: string;
}

interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildDynamoAgentContext(
	config: DynamoProviderRuntimeConfig,
	sessionId?: string,
): DynamoAgentContext {
	const trajectoryId = config.trajectoryId ?? sessionId;
	const resolvedSessionId = config.sessionId ?? sessionId;
	return {
		...(trajectoryId ? { trajectory_id: trajectoryId } : {}),
		...(config.parentTrajectoryId ? { parent_trajectory_id: config.parentTrajectoryId } : {}),
		...(resolvedSessionId ? { session_id: resolvedSessionId } : {}),
		session_type_id: config.sessionTypeId,
		phase: "reasoning",
	};
}

export function mergeDynamoAgentContext(payload: unknown, agentContext: DynamoAgentContext): unknown {
	const payloadRecord = isRecord(payload) ? payload : {};
	const existingNvext = isRecord(payloadRecord.nvext) ? payloadRecord.nvext : {};
	const existingAgentContext = isRecord(existingNvext.agent_context) ? existingNvext.agent_context : {};

	return {
		...payloadRecord,
		nvext: {
			...existingNvext,
			agent_context: {
				...agentContext,
				...existingAgentContext,
			},
		},
	};
}

export function mergeDynamoSessionControl(payload: unknown, sessionControl: DynamoSessionControl): unknown {
	const payloadRecord = isRecord(payload) ? payload : {};
	const existingNvext = isRecord(payloadRecord.nvext) ? payloadRecord.nvext : {};
	const existingSessionControl = isRecord(existingNvext.session_control) ? existingNvext.session_control : {};

	return {
		...payloadRecord,
		nvext: {
			...existingNvext,
			session_control: {
				...sessionControl,
				...existingSessionControl,
			},
		},
	};
}

export function buildDynamoHeaders(
	headers: Record<string, string> | undefined,
	createRequestId: () => string = randomUUID,
): Record<string, string> {
	const nextHeaders = { ...headers };
	const normalizedTarget = "x-request-id";
	const hasIt = Object.keys(nextHeaders).some((key) => key.toLowerCase() === normalizedTarget);
	if (!hasIt) {
		nextHeaders["x-request-id"] = createRequestId();
	}
	return nextHeaders;
}

export async function discoverDynamoModels(
	config: DynamoProviderRuntimeConfig,
	options: { timeoutMs?: number } = {},
): Promise<DynamoModelEntry[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
	try {
		const response = await fetch(`${config.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) return [];
		const body = (await response.json()) as OpenAIModelsResponse;
		const modelIds =
			body.data
				?.map((model) => model.id)
				.filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
		return [...new Set(modelIds)].map((id) => ({ id, name: id }));
	} catch {
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Manages a single Dynamo streaming session for KV isolation.
 * Lifecycle: open on first turn, sticky on subsequent turns, close on agent_end.
 */
export class DynamoSubagentSession {
	readonly sessionId: string;
	modelId = "";
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly timeoutSecs: number | undefined;
	private readonly createRequestId: () => string;
	private opened = false;

	constructor(
		config: Pick<DynamoProviderRuntimeConfig, "baseUrl" | "apiKey"> & {
			sessionControlId: string;
			sessionTimeoutSecs?: number;
		},
		createRequestId: () => string = randomUUID,
	) {
		this.sessionId = config.sessionControlId;
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.timeoutSecs = config.sessionTimeoutSecs;
		this.createRequestId = createRequestId;
	}

	controlForTurn(): DynamoSessionControl {
		const action = this.opened ? undefined : ("open" as const);
		this.opened = true;
		return {
			session_id: this.sessionId,
			...(action ? { action } : {}),
			...(this.timeoutSecs !== undefined ? { timeout: this.timeoutSecs } : {}),
		};
	}

	async close(fetchImpl: FetchLike = fetch): Promise<boolean> {
		if (!this.opened) return false;
		this.opened = false;
		const sessionControl: DynamoSessionControl = { session_id: this.sessionId, action: "close" };
		const body = {
			model: this.modelId,
			messages: [{ role: "user", content: "." }],
			max_tokens: 1,
			stream: false,
			nvext: { session_control: sessionControl },
		};
		try {
			const response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.apiKey}`,
					"x-request-id": this.createRequestId(),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}
}
