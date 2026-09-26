import assert from "node:assert";
import { describe, it } from "node:test";
import { LRU, lru } from "../../src/lru.js";

/**
 * Collects [key, value] pairs observed via forEach().
 *
 * @param {LRU} cache - The cache to iterate.
 * @returns {Array<Array<*>>} Observed pairs in iteration order.
 */
function forEachPairs(cache) {
	const pairs = [];
	cache.forEach((value, key) => pairs.push([key, value]));

	return pairs;
}

/**
 * Asserts every traversal interface agrees on the same logical content.
 *
 * @param {LRU} cache - The cache under test.
 * @param {Array<Array<*>>} expected - Expected [key, value] pairs in LRU order.
 * @param {string} label - Assertion label prefix.
 */
function assertConsistent(cache, expected, label) {
	const keys = expected.map(([key]) => key);
	const values = expected.map(([, value]) => value);

	assert.deepEqual(cache.keys(), keys, `${label}: keys()`);
	assert.deepEqual(cache.entries(), expected, `${label}: entries()`);
	assert.deepEqual(cache.values(), values, `${label}: values()`);
	assert.deepEqual(forEachPairs(cache), expected, `${label}: forEach()`);
	assert.deepEqual(
		cache.toJSON().map((item) => [item.key, item.value]),
		expected,
		`${label}: toJSON()`,
	);
	assert.equal(cache.size, expected.length, `${label}: size`);
	assert.equal(cache.keys().length, cache.size, `${label}: keys().length === size`);
	assert.equal(cache.entries().length, cache.size, `${label}: entries().length === size`);
	assert.equal(cache.values().length, cache.size, `${label}: values().length === size`);
	assert.equal(cache.toJSON().length, cache.size, `${label}: toJSON().length === size`);
	assert.equal(cache.sizeByTTL().valid, cache.size, `${label}: sizeByTTL().valid === size`);
	assert.deepEqual(cache.keysByTTL().valid, cache.keys(), `${label}: keysByTTL().valid === keys()`);
	assert.deepEqual(
		cache.valuesByTTL().valid,
		cache.values(),
		`${label}: valuesByTTL().valid === values()`,
	);
}

describe("traversal interface consistency", function () {
	describe("keys() with expired items", function () {
		it("should exclude an expired item at the head of the list", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2).set("c", 3);
			cache.items["a"].expiry = 0;

			assertConsistent(
				cache,
				[
					["b", 2],
					["c", 3],
				],
				"expired head",
			);
		});

		it("should exclude an expired item in the middle of the list", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2).set("c", 3);
			cache.items["b"].expiry = 0;

			assertConsistent(
				cache,
				[
					["a", 1],
					["c", 3],
				],
				"expired middle",
			);
		});

		it("should exclude an expired item at the tail of the list", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2).set("c", 3);
			cache.items["c"].expiry = 0;

			assertConsistent(
				cache,
				[
					["a", 1],
					["b", 2],
				],
				"expired tail",
			);
		});

		it("should return empty results when every item is expired", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2);
			cache.items["a"].expiry = 0;
			cache.items["b"].expiry = 0;

			assertConsistent(cache, [], "all expired");
		});

		it("should exclude expired items after real TTL elapses", async function () {
			const cache = new LRU(0, 30);
			cache.set("a", 1).set("b", 2);

			await new Promise((resolve) => setTimeout(resolve, 60));

			cache.set("c", 3);
			assertConsistent(cache, [["c", 3]], "ttl elapsed");
		});
	});

	describe("size with expired items", function () {
		it("should not count expired items", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2).set("c", 3);
			cache.items["b"].expiry = 0;

			assert.equal(cache.size, 2);
		});

		it("should be 0 when all items are expired", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2);
			cache.items["a"].expiry = 0;
			cache.items["b"].expiry = 0;

			assert.equal(cache.size, 0);
		});

		it("should count all items when ttl is 0", function () {
			const cache = new LRU(0, 0);
			cache.set("a", 1).set("b", 2);

			assert.equal(cache.size, 2);
		});

		it("should treat expiry equal to now as expired, consistent with get()", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2);
			cache.items["a"].expiry = Date.now();

			assert.equal(cache.get("a"), undefined, "get() treats expiry <= now as expired");
			assertConsistent(cache, [["b", 2]], "expiry boundary");
		});

		it("should not physically remove expired items when read", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1);
			cache.items["a"].expiry = 0;

			assert.equal(cache.size, 0, "logical size excludes the expired item");
			assert.equal(cache.peek("a"), 1, "peek() still observes the lazily stored item");
			assert.equal(cache.sizeByTTL().expired, 1, "sizeByTTL() still reports the expired item");
		});

		it("should agree with traversals after cleanup() removes expired items", function () {
			const cache = new LRU(0, 1000);
			cache.set("a", 1).set("b", 2).set("c", 3);
			cache.items["a"].expiry = 0;
			cache.items["c"].expiry = 0;

			assert.equal(cache.cleanup(), 2);
			assertConsistent(cache, [["b", 2]], "after cleanup");
		});

		it("should stay consistent as items expire and are re-set", function () {
			const cache = new LRU(2, 1000);
			cache.set("a", 1).set("b", 2);
			cache.items["a"].expiry = 0;

			assertConsistent(cache, [["b", 2]], "before re-set");
			cache.set("a", 10);
			assertConsistent(
				cache,
				[
					["b", 2],
					["a", 10],
				],
				"after re-set",
			);
		});
	});
});

describe("differential consistency fuzz", function () {
	/**
	 * Independent oracle used to cross-check every cache interface.
	 */
	class Model {
		constructor(max, ttl, resetTTL, now) {
			this.max = max;
			this.ttl = ttl;
			this.resetTTL = resetTTL;
			this.now = now;
			this.phy = new Map();
			this.counters = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0 };
			this.evictEvents = [];
		}

		expired(item) {
			return this.ttl !== 0 && item.expiry <= this.now();
		}

		liveEntries() {
			return [...this.phy.entries()]
				.filter(([, item]) => !this.expired(item))
				.map(([key, item]) => [key, item.value]);
		}

		set(key, value) {
			const item = this.phy.get(key);

			if (item !== undefined && !this.expired(item)) {
				item.value = value;
				if (this.resetTTL) {
					item.expiry = this.ttl > 0 ? this.now() + this.ttl : this.ttl;
				}
				this.phy.delete(key);
				this.phy.set(key, item);
			} else {
				if (item !== undefined) {
					this.phy.delete(key);
				}
				if (this.max > 0 && this.phy.size === this.max) {
					const firstKey = this.phy.keys().next().value;
					this.phy.delete(firstKey);
					this.counters.evictions++;
					this.evictEvents.push(firstKey);
				}
				this.phy.set(key, { value, expiry: this.ttl > 0 ? this.now() + this.ttl : this.ttl });
			}

			this.counters.sets++;
		}

		setWithEvicted(key, value) {
			const item = this.phy.get(key);
			let evicted = null;

			if (item !== undefined && !this.expired(item)) {
				item.value = value;
				if (this.resetTTL) {
					item.expiry = this.ttl > 0 ? this.now() + this.ttl : this.ttl;
				}
				this.phy.delete(key);
				this.phy.set(key, item);
			} else {
				if (item !== undefined) {
					this.phy.delete(key);
				}
				if (this.max > 0 && this.phy.size === this.max) {
					const firstKey = this.phy.keys().next().value;
					const firstItem = this.phy.get(firstKey);
					evicted = { key: firstKey, value: firstItem.value, expiry: firstItem.expiry };
					this.phy.delete(firstKey);
					this.counters.evictions++;
				}
				this.phy.set(key, { value, expiry: this.ttl > 0 ? this.now() + this.ttl : this.ttl });
			}

			this.counters.sets++;

			return evicted;
		}

		get(key) {
			const item = this.phy.get(key);

			if (item !== undefined) {
				if (!this.expired(item)) {
					this.phy.delete(key);
					this.phy.set(key, item);
					this.counters.hits++;

					return item.value;
				}
				this.phy.delete(key);
				this.counters.misses++;

				return undefined;
			}

			this.counters.misses++;

			return undefined;
		}

		has(key) {
			const item = this.phy.get(key);

			if (item !== undefined && this.expired(item)) {
				this.phy.delete(key);

				return false;
			}

			return item !== undefined;
		}

		peek(key) {
			const item = this.phy.get(key);

			return item !== undefined ? item.value : undefined;
		}

		expiresAt(key) {
			const item = this.phy.get(key);

			return item !== undefined ? item.expiry : undefined;
		}

		delete(key) {
			if (this.phy.delete(key)) {
				this.counters.deletes++;
			}
		}

		evict() {
			if (this.phy.size === 0) {
				return;
			}

			const firstKey = this.phy.keys().next().value;
			this.phy.delete(firstKey);
			this.counters.evictions++;
			this.evictEvents.push(firstKey);
		}

		clear() {
			this.phy.clear();
			this.counters = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0 };
		}

		cleanup() {
			if (this.ttl === 0 || this.phy.size === 0) {
				return 0;
			}

			let removed = 0;
			for (const key of Array.from(this.phy.keys())) {
				if (this.expired(this.phy.get(key))) {
					this.phy.delete(key);
					removed++;
				}
			}

			return removed;
		}
	}

	/**
	 * Deterministic PRNG (mulberry32).
	 *
	 * @param {number} seed - Seed value.
	 * @returns {function(): number} PRNG returning floats in [0, 1).
	 */
	function mulberry32(seed) {
		let state = seed >>> 0;

		return function () {
			state |= 0;
			state = (state + 0x6d2b79f5) | 0;
			let t = Math.imul(state ^ (state >>> 15), 1 | state);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/**
	 * Runs one seeded differential scenario against the oracle model.
	 * Must be called with Date.now mocked to return the scenario clock.
	 *
	 * @param {Object} clock - Shared mutable clock with a now property.
	 * @param {number} seed - PRNG seed.
	 * @param {number} max - Cache max.
	 * @param {number} ttl - Cache TTL.
	 * @param {boolean} resetTTL - Cache resetTTL flag.
	 * @param {number} steps - Number of random operations.
	 */
	function runScenario(clock, seed, max, ttl, resetTTL, steps) {
		const rand = mulberry32(seed);
		const cache = new LRU(max, ttl, resetTTL);
		const model = new Model(max, ttl, resetTTL, () => clock.now);
		const evictEvents = [];
		cache.onEvict((item) => evictEvents.push(item.key));
		const keyPool = ["a", "b", "c", "d", "e", "f"];
		const label = `seed=${seed} max=${max} ttl=${ttl} resetTTL=${resetTTL}`;

		for (let step = 0; step < steps; step++) {
			const roll = rand();
			const key = keyPool[Math.floor(rand() * keyPool.length)];

			if (roll < 0.35) {
				const value = Math.floor(rand() * 1000);
				cache.set(key, value);
				model.set(key, value);
			} else if (roll < 0.45) {
				const value = Math.floor(rand() * 1000);
				assert.deepEqual(
					cache.setWithEvicted(key, value),
					model.setWithEvicted(key, value),
					`${label} step=${step}: setWithEvicted() return`,
				);
			} else if (roll < 0.6) {
				assert.equal(cache.get(key), model.get(key), `${label} step=${step}: get()`);
			} else if (roll < 0.7) {
				assert.equal(cache.has(key), model.has(key), `${label} step=${step}: has()`);
			} else if (roll < 0.76) {
				cache.delete(key);
				model.delete(key);
			} else if (roll < 0.8) {
				cache.evict();
				model.evict();
			} else if (roll < 0.83) {
				cache.clear();
				model.clear();
			} else if (roll < 0.88) {
				assert.equal(cache.cleanup(), model.cleanup(), `${label} step=${step}: cleanup()`);
			} else {
				clock.now += [0, 1, 1, 2, Math.max(1, ttl), 97][Math.floor(rand() * 6)];
			}

			assert.equal(cache.peek(key), model.peek(key), `${label} step=${step}: peek()`);
			assert.equal(
				cache.expiresAt(key),
				model.expiresAt(key),
				`${label} step=${step}: expiresAt()`,
			);
			assertConsistent(cache, model.liveEntries(), `${label} step=${step}`);
			assert.deepEqual(cache.stats(), model.counters, `${label} step=${step}: stats()`);
			assert.deepEqual(evictEvents, model.evictEvents, `${label} step=${step}: onEvict events`);

			const forward = [];
			for (let node = cache.first; node !== null; node = node.next) {
				forward.push(node.key);
			}
			assert.deepEqual(forward, [...model.phy.keys()], `${label} step=${step}: list order`);
		}
	}

	/**
	 * Runs scenarios with Date.now mocked to a deterministic shared clock.
	 *
	 * @param {function(): void} fn - Callback invoking runScenario.
	 */
	function withMockedClock(fn) {
		const realNow = Date.now;
		const clock = { now: 1000000 };
		Date.now = () => clock.now;

		try {
			fn(clock);
		} finally {
			Date.now = realNow;
		}
	}

	it("should keep every interface consistent across systematic max/ttl/resetTTL combos", function () {
		withMockedClock((clock) => {
			let seed = 1;
			for (const max of [0, 1, 2, 3, 5]) {
				for (const ttl of [0, 1, 2, 5, 50]) {
					for (const resetTTL of [false, true]) {
						runScenario(clock, seed++, max, ttl, resetTTL, 60);
					}
				}
			}
		});
	});

	it("should keep every interface consistent across randomized scenarios", function () {
		withMockedClock((clock) => {
			const rand = mulberry32(999983);

			for (let i = 0; i < 50; i++) {
				const max = [0, 1, 2, 3, 4, 7][Math.floor(rand() * 6)];
				const ttl = [0, 1, 2, 3, 5, 10, 40][Math.floor(rand() * 7)];
				runScenario(clock, 1000 + i, max, ttl, rand() < 0.5, 80);
			}
		});
	});

	it("should expose the factory-created cache to the same invariants", function () {
		const cache = lru(3, 1000);
		cache.set("a", 1).set("b", 2);
		cache.items["a"].expiry = 0;

		assertConsistent(cache, [["b", 2]], "factory cache");
	});
});
