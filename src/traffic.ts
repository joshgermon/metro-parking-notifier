import { Effect, Schema } from 'effect';
import { ApiError } from './error';

const GoogleMapsResponse = Schema.Struct({
	rows: Schema.Tuple(
		Schema.Struct({
			elements: Schema.Tuple(
				Schema.Struct({
					duration: Schema.Struct({ value: Schema.Number }), // Standard time
					duration_in_traffic: Schema.Struct({ value: Schema.Number, text: Schema.String }), // Traffic time
				}),
			),
		}),
	),
	status: Schema.String,
});

export const checkTraffic = (from: string, station: string, apiKey: string) =>
	Effect.gen(function* () {
		const dest = `${station} Station, NSW`;
		const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(dest)}&departure_time=now&key=${apiKey}`;

		const response = yield* Effect.tryPromise({
			try: () => fetch(url),
			catch: (e) => new ApiError({ service: 'Traffic', reason: String(e) }),
		});

		const json = yield* Effect.tryPromise(() => response.json());

		const data = yield* Schema.decodeUnknown(GoogleMapsResponse)(json).pipe(
			Effect.mapError((e) => new ApiError({ service: 'Traffic', reason: 'Invalid JSON Schema' })),
		);

		if (data.status !== 'OK') {
			return { text: 'Unknown', delay: 0 };
		}

		const el = data.rows[0].elements[0];
		const delay = Math.max(0, Math.round((el.duration_in_traffic.value - el.duration.value) / 60));

		return { text: el.duration_in_traffic.text, delay };
	});
