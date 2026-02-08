import { Effect, Schema } from 'effect';
import { ApiError } from './error';

const levenshteinDistance = (a: string, b: string): number => {
	const matrix: number[][] = [];

	for (let i = 0; i <= b.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= a.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			if (b.charAt(i - 1) === a.charAt(j - 1)) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j - 1] + 1,
					matrix[i][j - 1] + 1,
					matrix[i - 1][j] + 1,
				);
			}
		}
	}

	return matrix[b.length][a.length];
};

export const findSimilarStations = (query: string, stations: string[], limit: number = 3): string[] => {
	const q = query.toLowerCase();

	const startsWith = stations.filter((s) => s.toLowerCase().startsWith(q));
	const contains = stations.filter((s) => s.toLowerCase().includes(q) && !startsWith.includes(s));

	const remaining = stations.filter((s) => !startsWith.includes(s) && !contains.includes(s));
	const byDistance = remaining
		.map((s) => ({ name: s, dist: levenshteinDistance(q, s.toLowerCase()) }))
		.filter((x) => x.dist <= 4)
		.sort((a, b) => a.dist - b.dist)
		.map((x) => x.name);

	return [...startsWith, ...contains, ...byDistance].slice(0, limit);
};

export const CarparkResponse = Schema.Struct({
	facility_id: Schema.String,
	facility_name: Schema.String,
	spots: Schema.String,
	occupancy: Schema.Struct({
		total: Schema.optional(Schema.NullOr(Schema.String)),
		loop: Schema.optional(Schema.NullOr(Schema.String)),
		transients: Schema.optional(Schema.NullOr(Schema.String)),
	}),
	zones: Schema.optional(
		Schema.Array(
			Schema.Struct({
				zone_name: Schema.String,
				spots: Schema.String,
				occupancy: Schema.Struct({
					total: Schema.optional(Schema.NullOr(Schema.String)),
					loop: Schema.optional(Schema.NullOr(Schema.String)),
					transients: Schema.optional(Schema.NullOr(Schema.String)),
				}),
			})
		)
	),
});

const StationData = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	ids: Schema.Array(Schema.String),
	location: Schema.Struct({
		lat: Schema.Number,
		lng: Schema.Number,
		address: Schema.String,
	}),
});

const StationsConfig = Schema.Struct({
	stations: Schema.Record({ key: Schema.String, value: StationData }),
	lastUpdated: Schema.String,
});

export type StationsConfig = Schema.Schema.Type<typeof StationsConfig>;
export type StationData = Schema.Schema.Type<typeof StationData>;

export const getStationsConfig = (env: Env) =>
	Effect.gen(function* () {
		const raw = yield* Effect.tryPromise(() => env.METRO_KV.get('stations_config_v2', 'json'));

		if (!raw) {
			return yield* Effect.fail(
				new ApiError({ service: 'Parking', reason: 'Stations not synced. Run: npm run sync-stations' }),
			);
		}

		return yield* Schema.decodeUnknown(StationsConfig)(raw).pipe(
			Effect.mapError(() => new ApiError({ service: 'Parking', reason: 'Invalid stations config in KV' })),
		);
	});

export const getStationList = (env: Env) =>
	getStationsConfig(env).pipe(Effect.map((config) => Object.keys(config.stations)));

export const getStationOptions = (env: Env) =>
	getStationsConfig(env).pipe(
		Effect.map((config) => Object.values(config.stations).map((s) => ({ name: s.name, id: s.id }))),
	);

export const resolveStationId = (query: string, env: Env) =>
	getStationsConfig(env).pipe(
		Effect.map((config) => {
			const q = query.toLowerCase();
			if (config.stations[q]) return q;
			const match = Object.values(config.stations).find((s) => s.name.toLowerCase() === q);
			return match?.id ?? null;
		}),
	);

const fetchFacility = (facilityId: string, apiKey: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://api.transport.nsw.gov.au/v1/carpark?facility=${facilityId}`, {
					headers: { Authorization: `apikey ${apiKey}` },
				}),
			catch: (e) => new ApiError({ service: 'Parking', reason: String(e) }),
		});

		const json = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: (e) => new ApiError({ service: 'Parking', reason: `JSON parse error: ${e}` }),
		});

		return yield* Schema.decodeUnknown(CarparkResponse)(json).pipe(
			Effect.mapError(() => new ApiError({ service: 'Parking', reason: `Invalid API response schema for facility ${facilityId}` }))
		);
	});

export type ZoneResult = {
	name: string;
	occupied: number;
	total: number;
	percent: number;
	fillRate: FillRate | null;
};

const ParkingSample = Schema.Struct({
	occupied: Schema.Number,
	total: Schema.Number,
	timestamp: Schema.Number,
	zones: Schema.optional(Schema.Array(Schema.Struct({
		name: Schema.String,
		occupied: Schema.Number,
		total: Schema.Number,
		percent: Schema.Number
	})))
});

type ParkingSample = Schema.Schema.Type<typeof ParkingSample>;

export type FillRate = {
	spotsPerMin: number;
	trend: 'filling' | 'stable' | 'emptying';
	description: string;
};

const describeFillRate = (spotsPerMin: number): string =>
	spotsPerMin >= 5 ? 'filling rapidly'
		: spotsPerMin >= 2 ? 'filling fast'
		: spotsPerMin > 0.5 ? 'filling steadily'
		: spotsPerMin > -0.5 ? 'stable'
		: spotsPerMin > -2 ? 'emptying slowly'
		: 'emptying fast';

const calculateFillRate = (
	samples: readonly ParkingSample[],
	getOccupied: (s: ParkingSample) => number | null = (s) => s.occupied,
): FillRate | null => {
	if (samples.length < 2) return null;

	let totalDelta = 0;
	let totalTimeMinutes = 0;

	for (let i = 1; i < samples.length; i++) {
		const prevOcc = getOccupied(samples[i - 1]);
		const currOcc = getOccupied(samples[i]);

		if (prevOcc === null || currOcc === null) continue;

		const timeDiff = (samples[i].timestamp - samples[i - 1].timestamp) / 60_000;
		totalDelta += currOcc - prevOcc;
		totalTimeMinutes += timeDiff;
	}

	if (totalTimeMinutes === 0) return null;

	const spotsPerMin = Math.round((totalDelta / totalTimeMinutes) * 10) / 10;
	const trend: FillRate['trend'] = spotsPerMin > 0.5 ? 'filling' : spotsPerMin < -0.5 ? 'emptying' : 'stable';

	return { spotsPerMin, trend, description: describeFillRate(spotsPerMin) };
};

export type ParkingResult = {
	percent: number;
	free: number;
	total: number;
	zones: ZoneResult[];
	fillRate: FillRate | null;
	lastUpdated: number;
	name: string;
};

export const parseOccupancy = (data: { occupancy: { total?: string | null; loop?: string | null; transients?: string | null } }): number => {
	// API docs: 'total' may be null, fall back to 'loop' or 'transients'
	const total = parseInt(data.occupancy.total ?? '', 10);
	if (!isNaN(total)) return total;

	const loop = parseInt(data.occupancy.loop ?? '', 10);
	if (!isNaN(loop)) return loop;

	const transients = parseInt(data.occupancy.transients ?? '', 10);
	if (!isNaN(transients)) return transients;

	return 0;
};

// Cloudflare KV free tier: 1,000 writes/day.
// 12 updates/hour * 24 hours = 288 writes/day (safe).
const ParkingState = Schema.Record({
	key: Schema.String,
	value: Schema.Array(ParkingSample)
});

type ParkingState = Schema.Schema.Type<typeof ParkingState>;

type ZoneSnapshot = { name: string; occupied: number; total: number; percent: number };

const fetchStationFacilities = (stationData: StationData, apiKey: string) =>
	Effect.gen(function* () {
		const facilities = yield* Effect.forEach(
			stationData.ids,
			(facilityId) => Effect.sleep('50 millis').pipe(Effect.flatMap(() => fetchFacility(facilityId, apiKey))),
			{ concurrency: 1 },
		);

		const zones: ZoneSnapshot[] = facilities.flatMap((data) => {
			if (data.zones && data.zones.length > 0) {
				return data.zones.map((z) => {
					const zSpots = parseInt(z.spots, 10) || 0;
					const zOcc = parseOccupancy(z);
					return { name: z.zone_name, occupied: zOcc, total: zSpots, percent: zSpots > 0 ? Math.round((zOcc / zSpots) * 100) : 0 };
				});
			}
			const facilitySpots = parseInt(data.spots, 10) || 0;
			const facilityOccupied = parseOccupancy(data);
			const zoneName = data.facility_name.replace('Park&Ride - ', '').trim();
			return [{ name: zoneName, occupied: facilityOccupied, total: facilitySpots, percent: facilitySpots > 0 ? Math.round((facilityOccupied / facilitySpots) * 100) : 0 }];
		});

		const totalSpots = facilities.reduce((sum, d) => sum + (parseInt(d.spots, 10) || 0), 0);
		const totalOccupied = facilities.reduce((sum, d) => sum + parseOccupancy(d), 0);

		return { occupied: totalOccupied, total: totalSpots, timestamp: Date.now(), zones } satisfies ParkingSample;
	});

const fetchAllStations = (config: StationsConfig, apiKey: string) =>
	Effect.gen(function* () {
		const entries = Object.entries(config.stations);

		const results = yield* Effect.forEach(
			entries,
			([stationId, stationData]) =>
				fetchStationFacilities(stationData, apiKey).pipe(
					Effect.map((sample) => ({ stationId, sample, error: null as string | null })),
					Effect.catchAll((e) => Effect.succeed({ stationId, sample: null as ParkingSample | null, error: `${stationId}: ${e}` })),
				),
			{ concurrency: 1 },
		);

		const samples = Object.fromEntries(
			results.filter((r): r is typeof r & { sample: ParkingSample } => r.sample !== null).map((r) => [r.stationId, r.sample]),
		);
		const errors = results.map((r) => r.error).filter((e): e is string => e !== null);

		return { samples, errors };
	});

const decodeParkingState = (raw: unknown) =>
	raw
		? Schema.decodeUnknown(ParkingState)(raw).pipe(Effect.orElseSucceed(() => ({}) as ParkingState))
		: Effect.succeed({} as ParkingState);

export const updateParkingState = (env: Env) =>
	Effect.gen(function* () {
		const config = yield* getStationsConfig(env);

		const oldStateRaw = yield* Effect.tryPromise(() => env.METRO_KV.get('parking_state_v1', 'json'));
		const oldState = yield* decodeParkingState(oldStateRaw);

		const { samples: newSamples, errors } = yield* fetchAllStations(config, env.TRANSPORT_NSW_API_KEY);

		const entries = Object.entries(newSamples);
		const changed = entries.some(([id, sample]) => {
			const prev = oldState[id]?.at(-1);
			return !prev || prev.occupied !== sample.occupied || prev.total !== sample.total;
		});

		const newState = Object.fromEntries(
			entries.map(([id, sample]) => [id, [...(oldState[id] || []), sample].slice(-5)]),
		);

		yield* Effect.tryPromise(() =>
			env.METRO_KV.put('parking_state_v1', JSON.stringify(newState), { expirationTtl: 3600 })
		);

		return { stationCount: entries.length, changed, errors };
	});

export const checkParking = (stationId: string, env: Env) =>
	Effect.gen(function* () {
		const config = yield* getStationsConfig(env);
		const stationData = config.stations[stationId];

		if (!stationData) {
			return yield* Effect.fail(new ApiError({ service: 'Parking', reason: `Unknown station ID: ${stationId}` }));
		}

		const stateRaw = yield* Effect.tryPromise(() => env.METRO_KV.get('parking_state_v1', 'json'));
		const state = yield* decodeParkingState(stateRaw);

		const history = state[stationId] ?? [];

		if (history.length === 0) {
			return { percent: 0, free: 0, total: 0, zones: [], fillRate: null, lastUpdated: 0, name: stationData.name };
		}

		const latest = history[history.length - 1];

		const zones: ZoneResult[] = (latest.zones ?? []).map(z => ({
			...z,
			fillRate: calculateFillRate(history, (s) => s.zones?.find(zone => zone.name === z.name)?.occupied ?? null),
		}));

		return {
			percent: latest.total > 0 ? Math.round((latest.occupied / latest.total) * 100) : 0,
			free: latest.total - latest.occupied,
			total: latest.total,
			zones,
			fillRate: calculateFillRate(history),
			lastUpdated: latest.timestamp,
			name: stationData.name
		};
	});
