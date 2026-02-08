import { Console, Effect, Schema, Schedule } from 'effect';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, statSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const CACHE_FILE = '.cache/stations-config.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const FacilitiesResponse = Schema.Record({ key: Schema.String, value: Schema.String });

const FacilityLocationResponse = Schema.Struct({
	location: Schema.Struct({
		latitude: Schema.String,
		longitude: Schema.String,
		address: Schema.String,
		suburb: Schema.String,
	}),
});

// Normalize station names to group facilities (e.g. "Tallawong P1" -> "Tallawong")
const parseStationName = (name: string): string => {
	return name
		.replace(/^Park&Ride - /, '')
		.replace(/ P\d+$/, '') // Remove P1, P2, etc.
		.replace(/ \((north|south|east|west|at-grade|multi-level)\)$/i, '') // Remove (north), (multi-level), etc.
		.trim();
};

const fetchFacilities = (apiKey: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch('https://api.transport.nsw.gov.au/v1/carpark', {
					headers: { Authorization: `apikey ${apiKey}` },
				}),
			catch: (e) => new Error(`Fetch failed: ${e}`),
		});

		const json = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: (e) => new Error(`JSON parse failed: ${e}`),
		});

		return yield* Schema.decodeUnknown(FacilitiesResponse)(json).pipe(
			Effect.mapError((e) => new Error(`Schema validation failed: ${e}`)),
		);
	});

const fetchFacilityLocation = (id: string, apiKey: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://api.transport.nsw.gov.au/v1/carpark?facility=${id}`, {
					headers: { Authorization: `apikey ${apiKey}` },
				}),
			catch: (e) => new Error(`Fetch failed for facility ${id}: ${e}`),
		});

		const json = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: (e) => new Error(`JSON parse failed for facility ${id}: ${e}`),
		});

		const data = yield* Schema.decodeUnknown(FacilityLocationResponse)(json).pipe(
			Effect.mapError((e) => new Error(`Schema validation failed for facility ${id}: ${e}`)),
		);

		return data.location;
	}).pipe(
		// Retry on failure with exponential backoff
		Effect.retry({
			schedule: Schedule.exponential('200 millis').pipe(Schedule.intersect(Schedule.recurs(3))),
		})
	);

const buildStationsConfig = (facilities: Record<string, string>, apiKey: string) =>
	Effect.gen(function* () {
		const grouping: Record<string, string[]> = {};

		for (const [id, name] of Object.entries(facilities)) {
			if (name.includes('historical only')) continue;

			const cleanName = parseStationName(name);
			if (!grouping[cleanName]) {
				grouping[cleanName] = [];
			}
			grouping[cleanName].push(id);
		}

		// New structure: mapped by station ID (slug)
		const stations: Record<
			string,
			{ 
				id: string;
				name: string;
				ids: string[]; 
				location: { lat: number; lng: number; address: string };
			}
		> = {};

		const entries = Object.entries(grouping);
		let i = 0;

		for (const [name, ids] of entries) {
			i++;
			yield* Console.log(`[${i}/${entries.length}] Fetching location for ${name}...`);
			
			// Use the first facility's location
			const loc = yield* fetchFacilityLocation(ids[0], apiKey);
			
			// Create a slug ID (e.g., "tallawong")
			const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

			stations[id] = { 
				id,
				name,
				ids, 
				location: {
					lat: parseFloat(loc.latitude),
					lng: parseFloat(loc.longitude),
					address: `${loc.address}, ${loc.suburb}`
				}
			};
			
			// Rate limit: Sleep 200ms between requests
			yield* Effect.sleep('200 millis');
		}

		return {
			stations,
			lastUpdated: new Date().toISOString(),
		};
	});

const writeToKV = (config: unknown) =>
	Effect.gen(function* () {
		const tempFile = '/tmp/stations_config_v2.json';
		writeFileSync(tempFile, JSON.stringify(config));

		yield* Effect.try({
			try: () => {
				execSync(`npx wrangler kv key put stations_config_v2 --path=${tempFile} --binding=METRO_KV --remote`, {
					stdio: 'inherit',
				});
			},
			catch: (e) => new Error(`KV write failed: ${e}`),
		});

		unlinkSync(tempFile);
	});

const readCache = () =>
	Effect.gen(function* () {
		if (!existsSync(CACHE_FILE)) return null;

		const stats = statSync(CACHE_FILE);
		if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) {
			yield* Console.log('Cache expired, refreshing...');
			return null;
		}

		yield* Console.log('Using local cache (valid for 24h)');
		const content = readFileSync(CACHE_FILE, 'utf-8');
		return JSON.parse(content);
	});

const writeCache = (config: unknown) =>
	Effect.gen(function* () {
		const dir = dirname(CACHE_FILE);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(CACHE_FILE, JSON.stringify(config, null, 2));
		yield* Console.log(`Cache updated at ${CACHE_FILE}`);
	});

const syncStations = Effect.gen(function* () {
	// Try to read from cache first
	let config = yield* readCache();

	if (!config) {
		const apiKey = process.env.TRANSPORT_NSW_API_KEY;

		if (!apiKey) {
			return yield* Effect.fail(new Error('Missing TRANSPORT_NSW_API_KEY in .dev.vars'));
		}

		yield* Console.log('Fetching facilities from Transport NSW...');
		const facilities = yield* fetchFacilities(apiKey);

		config = yield* buildStationsConfig(facilities, apiKey);
		const stationCount = Object.keys(config.stations).length;

		yield* Console.log(`Found ${stationCount} stations (grouped)`);
		
		// Update cache
		yield* writeCache(config);
	}

	yield* Console.log('Writing to KV...');

	yield* writeToKV(config);

	yield* Console.log('Stations synced successfully!');
});

Effect.runPromise(syncStations).catch((e) => {
	console.error('Sync failed:', e.message);
	process.exit(1);
});
