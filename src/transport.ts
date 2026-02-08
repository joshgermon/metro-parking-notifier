import { Effect, Schema } from 'effect';
import { ApiError } from './error';

const CarparkSchema = Schema.Struct({
	occupancy: Schema.Struct({
		total: Schema.NumberFromString,
		filled: Schema.NumberFromString,
	}),
});

const TfNswResponse = Schema.Record({ key: Schema.String, value: CarparkSchema });

const STATIONS: Record<string, string[]> = {
	Kellyville: ['21', '22'],
	Tallawong: ['20'],
	'Bella Vista': ['23'],
	'Hills Showground': ['24'],
	Cherrybrook: ['25'],
};

export const checkParking = (stationName: string, apiKey: string) =>
	Effect.gen(function* () {
		const ids = STATIONS[stationName];
		if (!ids) yield* new ApiError({ service: 'Parking', reason: 'Invalid Station Name' });

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch('https://api.transport.nsw.gov.au/v1/carpark', {
					headers: { Authorization: `apikey ${apiKey}` },
				}),
			catch: (e) => new ApiError({ service: 'Parking', reason: String(e) }),
		});

		const json = yield* Effect.tryPromise(() => response.json());

		const data = yield* Schema.decodeUnknown(TfNswResponse)(json).pipe(
			Effect.mapError((e) => new ApiError({ service: 'Parking', reason: 'Invalid JSON Schema' })),
		);

		let total = 0,
			filled = 0;

		for (const id of ids) {
			if (data[id]) {
				total += data[id].occupancy.total;
				filled += data[id].occupancy.filled;
			}
		}

		return {
			percent: total > 0 ? Math.round((filled / total) * 100) : 0,
			free: total - filled,
			total,
		};
	});
