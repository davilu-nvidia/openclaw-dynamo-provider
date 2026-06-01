// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DYNAMO_PROVIDER_ID = "dynamo";
export const DEFAULT_DYNAMO_BASE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_DYNAMO_API_KEY = "dynamo-local";
export const DEFAULT_SESSION_TYPE_ID = "openclaw_coding_agent";
export const DEFAULT_DYNAMO_MODEL_ID = "default";

export interface DynamoEnvironment {
	DYNAMO_BASE_URL?: string;
	OPENAI_BASE_URL?: string;
	DYNAMO_API_KEY?: string;
	DYN_AGENT_TRACE?: string;
	DYN_AGENT_SESSION_TYPE_ID?: string;
	DYN_AGENT_SESSION_ID?: string;
	DYN_AGENT_TRAJECTORY_ID?: string;
	DYN_AGENT_PARENT_TRAJECTORY_ID?: string;
	DYN_AGENT_SESSION_TIMEOUT?: string;
	PI_SUBAGENT_CHILD?: string;
	PI_SUBAGENT_RUN_ID?: string;
	PI_SUBAGENT_CHILD_AGENT?: string;
	PI_SUBAGENT_CHILD_INDEX?: string;
	// OpenClaw equivalents
	OPENCLAW_AGENT_CHILD?: string;
	OPENCLAW_AGENT_RUN_ID?: string;
	OPENCLAW_AGENT_CHILD_AGENT?: string;
	OPENCLAW_AGENT_CHILD_INDEX?: string;
}

export interface DynamoProviderRuntimeConfig {
	baseUrl: string;
	apiKey: string;
	traceEnabled: boolean;
	sessionTypeId: string;
	sessionId?: string;
	trajectoryId?: string;
	parentTrajectoryId?: string;
	sessionControlId?: string;
	sessionTimeoutSecs?: number;
}

export interface DynamoSessionControl {
	session_id: string;
	action?: "open" | "close";
	timeout?: number;
}

export interface DynamoAgentContext {
	trajectory_id?: string;
	parent_trajectory_id?: string;
	session_id?: string;
	session_type_id: string;
	phase: "reasoning";
}

function getEnvValue(env: DynamoEnvironment, key: keyof DynamoEnvironment): string | undefined {
	const value = env[key];
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeDynamoBaseUrl(rawBaseUrl: string | undefined): string {
	const raw = rawBaseUrl?.trim() || DEFAULT_DYNAMO_BASE_URL;
	const withoutTrailingSlash = raw.replace(/\/+$/, "");
	try {
		const url = new URL(withoutTrailingSlash);
		if (url.pathname === "" || url.pathname === "/") {
			url.pathname = "/v1";
		}
		return url.toString().replace(/\/+$/, "");
	} catch {
		return withoutTrailingSlash;
	}
}

export function computeSubagentSessionId(env: DynamoEnvironment): string | undefined {
	// Support both pi-subagents and OpenClaw agent env vars
	const isChild =
		getEnvValue(env, "PI_SUBAGENT_CHILD") === "1" ||
		getEnvValue(env, "OPENCLAW_AGENT_CHILD") === "1";
	if (!isChild) return undefined;

	const runId = getEnvValue(env, "PI_SUBAGENT_RUN_ID") ?? getEnvValue(env, "OPENCLAW_AGENT_RUN_ID");
	const childAgent = getEnvValue(env, "PI_SUBAGENT_CHILD_AGENT") ?? getEnvValue(env, "OPENCLAW_AGENT_CHILD_AGENT");
	if (!runId || !childAgent) return undefined;

	const childIndex =
		getEnvValue(env, "PI_SUBAGENT_CHILD_INDEX") ??
		getEnvValue(env, "OPENCLAW_AGENT_CHILD_INDEX") ??
		"0";
	return `${runId}:${childAgent}:${childIndex}`;
}

export function computeSubagentTrajectoryRewrite(
	env: DynamoEnvironment,
): { trajectoryId: string; parentTrajectoryId: string } | null {
	if (getEnvValue(env, "DYN_AGENT_PARENT_TRAJECTORY_ID")) return null;
	const inherited = getEnvValue(env, "DYN_AGENT_TRAJECTORY_ID");
	if (!inherited) return null;
	const trajectoryId = computeSubagentSessionId(env);
	if (!trajectoryId) return null;
	return { parentTrajectoryId: inherited, trajectoryId };
}

export function applySubagentBridge(env: NodeJS.ProcessEnv = process.env): boolean {
	const rewrite = computeSubagentTrajectoryRewrite(env);
	if (!rewrite) return false;
	env.DYN_AGENT_PARENT_TRAJECTORY_ID = rewrite.parentTrajectoryId;
	env.DYN_AGENT_TRAJECTORY_ID = rewrite.trajectoryId;
	return true;
}

export function readDynamoConfig(env: DynamoEnvironment = process.env): DynamoProviderRuntimeConfig {
	const rewrite = computeSubagentTrajectoryRewrite(env);
	const sessionId = getEnvValue(env, "DYN_AGENT_SESSION_ID");
	const trajectoryId = rewrite?.trajectoryId ?? getEnvValue(env, "DYN_AGENT_TRAJECTORY_ID");
	const parentTrajectoryId = rewrite?.parentTrajectoryId ?? getEnvValue(env, "DYN_AGENT_PARENT_TRAJECTORY_ID");
	const sessionControlId = computeSubagentSessionId(env);
	const sessionTimeoutSecs = parsePositiveIntOrUndefined(getEnvValue(env, "DYN_AGENT_SESSION_TIMEOUT"));

	return {
		baseUrl: normalizeDynamoBaseUrl(getEnvValue(env, "DYNAMO_BASE_URL") ?? getEnvValue(env, "OPENAI_BASE_URL")),
		apiKey: getEnvValue(env, "DYNAMO_API_KEY") ?? DEFAULT_DYNAMO_API_KEY,
		traceEnabled: isTruthyEnv(getEnvValue(env, "DYN_AGENT_TRACE")),
		sessionTypeId: getEnvValue(env, "DYN_AGENT_SESSION_TYPE_ID") ?? DEFAULT_SESSION_TYPE_ID,
		...(sessionId ? { sessionId } : {}),
		...(trajectoryId ? { trajectoryId } : {}),
		...(parentTrajectoryId ? { parentTrajectoryId } : {}),
		...(sessionControlId ? { sessionControlId } : {}),
		...(sessionTimeoutSecs !== undefined ? { sessionTimeoutSecs } : {}),
	};
}
