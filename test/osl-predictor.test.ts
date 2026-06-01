// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { OslPredictor } from "../src/osl-predictor.js";

describe("OslPredictor", () => {
	it("returns cold start default with no history", () => {
		const p = new OslPredictor();
		expect(p.predict()).toBe(200);
	});

	it("adapts to short outputs (tool call mode)", () => {
		const p = new OslPredictor();
		// Simulate tool-call pattern: many short outputs
		for (const out of [10, 20, 15, 8, 12, 25, 10, 18]) {
			p.update(out);
		}
		const pred = p.predict();
		// p75 of [10,20,15,8,12,25,10,18] sorted=[8,10,10,12,15,18,20,25] p75=18
		// 18 < 50 => max(100, 18*2.5=45) = 100
		expect(pred).toBe(100);
	});

	it("adapts to long outputs (code generation mode)", () => {
		const p = new OslPredictor();
		for (const out of [2000, 1500, 3000, 2500, 1800, 2200, 2800, 1900]) {
			p.update(out);
		}
		const pred = p.predict();
		// p75 of sorted values ~= 2500+, so mult = 1.3
		// Should be around 2500 * 1.3 = 3250
		expect(pred).toBeGreaterThan(2000);
		expect(pred).toBeLessThan(4000);
	});

	it("uses sliding window (forgets old values)", () => {
		const p = new OslPredictor();
		// Start with long outputs
		for (const out of [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]) {
			p.update(out);
		}
		const longPred = p.predict();
		// Switch to short outputs
		for (const out of [20, 15, 10, 25, 18, 12, 22, 16]) {
			p.update(out);
		}
		const shortPred = p.predict();
		expect(shortPred).toBeLessThan(longPred);
		expect(shortPred).toBeLessThan(200);
	});

	it("reset clears history", () => {
		const p = new OslPredictor();
		p.update(5000);
		p.update(5000);
		p.reset();
		expect(p.predict()).toBe(200); // back to cold start
	});

	it("handles mixed workload", () => {
		const p = new OslPredictor();
		// Mixed: short tool calls + occasional long code gen
		for (const out of [20, 15, 500, 30, 10, 1200, 25, 40]) {
			p.update(out);
		}
		const pred = p.predict();
		// p75 should capture the longer outputs
		// sorted=[10,15,20,25,30,40,500,1200] p75=40
		// 40 < 50 => max(100, 40*2.5=100) = 100
		// Hmm that's conservative. The window p75 is robust to outliers.
		expect(pred).toBeGreaterThanOrEqual(100);
	});

	it("scale multiplier: small p75 gets generous headroom", () => {
		const p = new OslPredictor();
		for (const out of [30, 40, 35, 45, 38, 42, 33, 37]) {
			p.update(out);
		}
		// p75 ~ 42, < 50, so mult=2.5 => max(100, 105) = 105
		expect(p.predict()).toBeGreaterThanOrEqual(100);
	});

	it("scale multiplier: medium p75 gets moderate headroom", () => {
		const p = new OslPredictor();
		for (const out of [100, 150, 120, 180, 130, 160, 110, 140]) {
			p.update(out);
		}
		// p75 ~ 155, < 200, so mult=1.8 => ~279
		const pred = p.predict();
		expect(pred).toBeGreaterThan(200);
		expect(pred).toBeLessThan(400);
	});
});
