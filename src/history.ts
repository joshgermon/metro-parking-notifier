import { Effect, Schema } from 'effect';
import { updateParkingState, getStationList, checkParking } from './transport';
import { getSydneyTime } from './time';

const BucketData = Schema.Struct({
	samples: Schema.Array(Schema.Number),
	avg: Schema.Number,
	count: Schema.Number,
});

const DailyHistory = Schema.Record({ 
	key: Schema.String, 
	value: Schema.Record({ key: Schema.String, value: BucketData }) 
});

type DailyHistory = Schema.Schema.Type<typeof DailyHistory>;
export type BucketData = Schema.Schema.Type<typeof BucketData>;
export type HistoricalData = Record<string, BucketData>;

export const recordBatchFillRates = (results: Record<string, number>, dayOfWeek: string, hour: number, env: Env) =>
	Effect.gen(function* () {
		const key = `history:v2:${dayOfWeek}`;
		const hourKey = String(Math.floor(hour * 2) / 2);

		const existingRaw = yield* Effect.tryPromise(() => env.METRO_KV.get(key, 'json'));
		
		type MutableBucket = { samples: number[]; avg: number; count: number };
		type MutableDayHistory = Record<string, Record<string, MutableBucket>>;
		
		let dayData: MutableDayHistory = {};
		
		if (existingRaw) {
			const parsed = yield* Schema.decodeUnknown(DailyHistory)(existingRaw).pipe(Effect.orElseSucceed(() => null));
			if (parsed) {
				dayData = JSON.parse(JSON.stringify(parsed));
			}
		}

		for (const [stationName, percent] of Object.entries(results)) {
			if (!dayData[stationName]) {
				dayData[stationName] = {};
			}
			
			const stationHistory = dayData[stationName];
			const bucket = stationHistory[hourKey] || { samples: [], avg: 0, count: 0 };

			bucket.samples.push(percent);
			bucket.count++;
			bucket.avg = Math.round(bucket.samples.reduce((a, b) => a + b, 0) / bucket.count);

			if (bucket.samples.length > 30) {
				bucket.samples = bucket.samples.slice(-30);
			}

			stationHistory[hourKey] = bucket;
		}

		yield* Effect.tryPromise(() => env.METRO_KV.put(key, JSON.stringify(dayData)));
	});

export const getHistoricalData = (station: string, dayOfWeek: string, env: Env) =>
	Effect.gen(function* () {
		const v2Key = `history:v2:${dayOfWeek}`;
		const v2Raw = yield* Effect.tryPromise(() => env.METRO_KV.get(v2Key, 'json'));

		if (v2Raw) {
			const dayData = yield* Schema.decodeUnknown(DailyHistory)(v2Raw).pipe(Effect.orElseSucceed(() => null));
			if (dayData && dayData[station]) {
				return dayData[station] as HistoricalData;
			}
		}

		return null;
	});

export interface CollectionResult {
	changed: boolean;
	stationsChecked: number;
	stationsRecorded: number;
	zoneKeysRecorded: number;
	dayOfWeek: string;
	hour: string;
	fetchErrors: string[];
}

export const collectHistoricalData = (env: Env) =>
	Effect.gen(function* () {
		const sydney = getSydneyTime();
		const dayOfWeek = sydney.dayOfWeek;
		const hour = sydney.hour + sydney.minute / 60;

		const { stationCount, changed, errors } = yield* updateParkingState(env);
		
		if (!changed) {
			return {
				changed: false,
				stationsChecked: stationCount,
				stationsRecorded: 0,
				zoneKeysRecorded: 0,
				dayOfWeek,
				hour: hour.toFixed(2),
				fetchErrors: errors,
			} satisfies CollectionResult;
		}
		
		const stations = yield* getStationList(env).pipe(Effect.orElseSucceed(() => [] as string[]));

		const parkingResults = yield* Effect.forEach(
			stations,
			(stationId) => checkParking(stationId, env).pipe(Effect.orElseSucceed(() => null)),
		);

		const results = Object.fromEntries(
			parkingResults
				.filter((p): p is NonNullable<typeof p> => p !== null)
				.flatMap((parking) => [
					[parking.name, parking.percent] as const,
					...parking.zones.map((zone) => [`${parking.name}::${zone.name}`, zone.percent] as const),
				]),
		);

		if (Object.keys(results).length > 0) {
			yield* recordBatchFillRates(results, dayOfWeek, hour, env);
		}

		const stationNames = new Set(Object.keys(results).filter(k => !k.includes('::')));
		const zoneKeys = Object.keys(results).filter(k => k.includes('::'));

		return {
			changed: true,
			stationsChecked: stationCount,
			stationsRecorded: stationNames.size,
			zoneKeysRecorded: zoneKeys.length,
			dayOfWeek,
			hour: hour.toFixed(2),
			fetchErrors: errors,
		} satisfies CollectionResult;
	});
