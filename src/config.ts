// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DYNAMO_PROVIDER_ID = "dynamo";
export const DEFAULT_DYNAMO_BASE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_DYNAMO_API_KEY = "dynamo-local";
export const DEFAULT_WORKFLOW_TYPE_ID = "openclaw_coding_agent";
export const DEFAULT_DYNAMO_MODEL_ID = "default";

export interface DynamoEnvironment {
	DYNAMO_BASE_URL?: string;
	OPENAI_BASE_URL?: string;
	DYNAMO_API_KEY?: string;
	DYN_AGENT_TRACE?: string;
	DYN_AGENT_WORKFLOW_TYPE_ID?: string;
	DYN_AGENT_WORKFLOW_ID?: string;
	DYN_AGENT_PROGRAM_ID?: string;
	DYN_AGENT_PARENT_PROGRAM_ID?: string;
	DYN_AGENT_SESSION_TIMEOUT?: string;
	// Agent hints
	DYN_AGENT_PRIORITY?: string;
	DYN_AGENT_OSL?: string;
	DYN_AGENT_SPECULATIVE_PREFILL?: string;
	// Subagent identity (pi-subagents compat)
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
	workflowTypeId: string;
	workflowId?: string;
	programId?: string;
	parentProgramId?: string;
	sessionControlId?: string;
	sessionTimeoutSecs?: number;
	// Agent hints
	priority?: number;
	osl?: number;
	speculativePrefill?: boolean;
}

export interface DynamoSessionControl {
	session_id: string;
	action?: "open" | "close";
	timeout?: number;
}

export interface DynamoAgentContext {
	workflow_type_id: string;
	workflow_id: string;
	program_id: string;
	parent_program_id?: string;
}

export interface DynamoAgentHints {
	priority?: number;
	osl?: number;
	speculative_prefill?: boolean;
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

function parseIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
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

export function computeSubagentProgramRewrite(
	env: DynamoEnvironment,
): { programId: string; parentProgramId: string } | null {
	if (getEnvValue(env, "DYN_AGENT_PARENT_PROGRAM_ID")) return null;
	const inherited = getEnvValue(env, "DYN_AGENT_PROGRAM_ID");
	if (!inherited) return null;
	const programId = computeSubagentSessionId(env);
	if (!programId) return null;
	return { parentProgramId: inherited, programId };
}

export function applySubagentBridge(env: NodeJS.ProcessEnv = process.env): boolean {
	const rewrite = computeSubagentProgramRewrite(env);
	if (!rewrite) return false;
	env.DYN_AGENT_PARENT_PROGRAM_ID = rewrite.parentProgramId;
	env.DYN_AGENT_PROGRAM_ID = rewrite.programId;
	return true;
}

export function readDynamoConfig(env: DynamoEnvironment = process.env): DynamoProviderRuntimeConfig {
	const rewrite = computeSubagentProgramRewrite(env);
	const workflowId = getEnvValue(env, "DYN_AGENT_WORKFLOW_ID");
	const programId = rewrite?.programId ?? getEnvValue(env, "DYN_AGENT_PROGRAM_ID");
	const parentProgramId = rewrite?.parentProgramId ?? getEnvValue(env, "DYN_AGENT_PARENT_PROGRAM_ID");
	const sessionControlId = computeSubagentSessionId(env);
	const sessionTimeoutSecs = parsePositiveIntOrUndefined(getEnvValue(env, "DYN_AGENT_SESSION_TIMEOUT"));

	const priority = parseIntOrUndefined(getEnvValue(env, "DYN_AGENT_PRIORITY"));
	const osl = parsePositiveIntOrUndefined(getEnvValue(env, "DYN_AGENT_OSL"));
	const speculativePrefillRaw = getEnvValue(env, "DYN_AGENT_SPECULATIVE_PREFILL");
	const speculativePrefill = speculativePrefillRaw !== undefined ? isTruthyEnv(speculativePrefillRaw) : undefined;

	return {
		baseUrl: normalizeDynamoBaseUrl(getEnvValue(env, "DYNAMO_BASE_URL") ?? getEnvValue(env, "OPENAI_BASE_URL")),
		apiKey: getEnvValue(env, "DYNAMO_API_KEY") ?? DEFAULT_DYNAMO_API_KEY,
		traceEnabled: isTruthyEnv(getEnvValue(env, "DYN_AGENT_TRACE")),
		workflowTypeId: getEnvValue(env, "DYN_AGENT_WORKFLOW_TYPE_ID") ?? DEFAULT_WORKFLOW_TYPE_ID,
		...(workflowId ? { workflowId } : {}),
		...(programId ? { programId } : {}),
		...(parentProgramId ? { parentProgramId } : {}),
		...(sessionControlId ? { sessionControlId } : {}),
		...(sessionTimeoutSecs !== undefined ? { sessionTimeoutSecs } : {}),
		...(priority !== undefined ? { priority } : {}),
		...(osl !== undefined ? { osl } : {}),
		...(speculativePrefill !== undefined ? { speculativePrefill } : {}),
	};
}
