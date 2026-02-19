import { Console, Effect, Logger } from 'effect';
import { handleInteraction } from './discord';
import { verifyDiscordSignature } from './signature';
import { processNotifications, type UserNotificationResult } from './notification';
import { collectHistoricalData, type CollectionResult } from './history';
import { getSydneyTime } from './time';

const handleRequest = (request: Request, env: Env) =>
	Effect.gen(function* () {
		const body = yield* Effect.promise(() => request.text());

		const signature = request.headers.get('x-signature-ed25519');
		const timestamp = request.headers.get('x-signature-timestamp');

		if (!signature || !timestamp) {
			yield* Console.log('Missing signature headers');
			return new Response(null, { status: 401 });
		}

		if (!env.DISCORD_PUBLIC_KEY) {
			yield* Console.error('DISCORD_PUBLIC_KEY not configured');
			return new Response('Server misconfigured', { status: 500 });
		}

		const verifyResult = yield* verifyDiscordSignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY).pipe(
			Effect.catchAll((e) => Console.error('Signature verification error:', e).pipe(Effect.as(false))),
		);

		if (!verifyResult) {
			yield* Console.log('Signature verification failed');
			return new Response(null, { status: 401 });
		}

		const json = yield* Effect.try({
			try: () => JSON.parse(body),
			catch: () => new Error('Invalid JSON'),
		});

		return yield* handleInteraction(json, env);
	});

const compactUserDetail = (n: UserNotificationResult) =>
	Object.fromEntries(
		([
			['user', n.userId.slice(-4)],
			['outcome', n.outcome],
			['reason', n.reason],
			['station', n.station],
			['leaveBy', n.leaveBy],
			['fill', n.currentFill !== undefined ? `${n.currentFill}%→${n.predictedFill}%` : undefined],
			['travel', n.travelMinutes !== undefined ? `${n.travelMinutes}m` : undefined],
			['traffic', n.trafficDelay ? `+${n.trafficDelay}m` : undefined],
			['zone', n.zoneName],
			['fillRate', n.fillRate],
			['trigger', n.trigger],
			['dmCached', n.dmChannelCached],
			['errorType', n.errorType],
			['deviation', n.deviation !== undefined ? `${n.deviation > 0 ? '+' : ''}${Math.round(n.deviation)}pp` : undefined],
		] as const).filter(([, v]) => v !== undefined && v !== null),
	);

const buildCronAnnotations = (
	sydney: { timeString: string; dayOfWeek: string },
	collection: CollectionResult | null,
	notifications: readonly UserNotificationResult[],
	mode: string,
): Record<string, unknown> => {
	const sent = notifications.filter(n => n.outcome === 'sent').length;
	const skipped = notifications.filter(n => n.outcome === 'skipped').length;
	const errorCount = notifications.filter(n => n.outcome === 'error').length;

	return {
		time: sydney.timeString,
		day: sydney.dayOfWeek,
		mode,
		...(collection && {
			changed: collection.changed,
			stationsChecked: collection.stationsChecked,
			stationsRecorded: collection.stationsRecorded,
			zoneKeysRecorded: collection.zoneKeysRecorded,
			...(collection.fetchErrors.length > 0 && { fetchErrors: collection.fetchErrors.join('; ') }),
		}),
		users: notifications.length,
		sent,
		skipped,
		errors: errorCount,
		...(notifications.length > 0 && { userDetails: JSON.stringify(notifications.map(compactUserDetail)) }),
	};
};

const annotatedLog = (message: string, annotations: Record<string, unknown>) =>
	Object.entries(annotations).reduce(
		(effect, [key, value]) => effect.pipe(Effect.annotateLogs(key, value)),
		Effect.log(message) as Effect.Effect<void>,
	);

const PEAK_START = 6;  // 6:00am — full processing starts
const PEAK_END = 9;    // 9:00am — full processing ends
const TRACK_START = 5; // 5:00am — data collection starts
const TRACK_END = 10;  // 10:00am — data collection ends
const OFF_PEAK_INTERVAL_MINUTES = 15; // Only collect data every 15 min outside peak

const handleScheduled = (_controller: ScheduledController, env: Env) =>
	Effect.gen(function* () {
		const sydney = getSydneyTime();
		const currentHour = sydney.hour + sydney.minute / 60;

		// Safety check: skip entirely outside tracking window (5am-10am)
		// The cron should already handle this, but belt-and-braces
		if (currentHour < TRACK_START || currentHour >= TRACK_END) {
			yield* annotatedLog('cron', { time: sydney.timeString, day: sydney.dayOfWeek, mode: 'outside_hours' });
			return;
		}

		const isPeak = currentHour >= PEAK_START && currentHour < PEAK_END;

		if (!isPeak) {
			// Off-peak (5-6am, 9-10am): only collect data every ~15 minutes
			if (sydney.minute % OFF_PEAK_INTERVAL_MINUTES >= 2) {
				// Skip this run — not on a ~15-minute boundary (allow 2-min window for cron jitter)
				yield* annotatedLog('cron', { time: sydney.timeString, day: sydney.dayOfWeek, mode: 'offpeak_skip' });
				return;
			}

			// Collect data but don't process notifications
			const collection = yield* collectHistoricalData(env);
			yield* annotatedLog(
				'cron',
				buildCronAnnotations({ timeString: sydney.timeString, dayOfWeek: sydney.dayOfWeek }, collection, [], 'offpeak_collect'),
			);
			return;
		}

		// Peak hours (6-9am): full processing every 2 minutes
		const collection = yield* collectHistoricalData(env);

		const notifications = collection.changed
			? yield* processNotifications(env)
			: [];

		yield* annotatedLog(
			'cron',
			buildCronAnnotations({ timeString: sydney.timeString, dayOfWeek: sydney.dayOfWeek }, collection, notifications, 'peak'),
		);
	});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const program = handleRequest(request, env).pipe(
			Effect.provide(Logger.json),
			Effect.catchAll((error) =>
				Console.error('Worker Error:', error).pipe(
					Effect.as(new Response('Internal Server Error', { status: 500 })),
				),
			),
		);

		return Effect.runPromise(program);
	},

	async scheduled(controller, env, ctx): Promise<void> {
		const program = handleScheduled(controller, env).pipe(
			Effect.provide(Logger.json),
			Effect.catchAll((error) => Console.error('Scheduled Error:', error)),
		);

		ctx.waitUntil(Effect.runPromise(program));
	},
} satisfies ExportedHandler<Env>;
