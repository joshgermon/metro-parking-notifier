import { Console, Effect, Schema } from 'effect';
import { ApiError, NotificationError } from './error';
import { calculateLeaveBy, type LeaveByResult, UserPrefs } from './calculator';
import { getSydneyTime, type SydneyTime } from './time';
import { renderGauge, formatFillRate, formatDecimalHour } from './format';
import type { FillRate } from './transport';

const getCachedDMChannel = (userId: string, env: Env) =>
	Effect.gen(function* () {
		const cached = yield* Effect.tryPromise(() => env.METRO_KV.get(`dm_channel:${userId}`, 'json'));
		if (cached) {
			return (cached as { channelId: string; createdAt: number }).channelId;
		}
		return null;
	});

const cacheDMChannel = (userId: string, channelId: string, env: Env) =>
	Effect.tryPromise(() =>
		env.METRO_KV.put(
			`dm_channel:${userId}`,
			JSON.stringify({ channelId, createdAt: Date.now() })
		)
	);

const clearCachedDMChannel = (userId: string, env: Env) =>
	Effect.tryPromise(() => env.METRO_KV.delete(`dm_channel:${userId}`));

const createDMChannel = (userId: string, botToken: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch('https://discord.com/api/v10/users/@me/channels', {
					method: 'POST',
					headers: {
						Authorization: `Bot ${botToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ recipient_id: userId }),
				}),
			catch: (e) => new NotificationError({ userId, reason: `Failed to call Discord API: ${String(e)}` }),
		});

		if (!response.ok) {
			const text = yield* Effect.tryPromise(() => response.text()).pipe(Effect.orElseSucceed(() => 'Unknown error'));
			return yield* Effect.fail(new NotificationError({ userId, reason: `Discord Create DM Channel Error ${response.status}: ${text}` }));
		}

		const json = (yield* Effect.tryPromise(() => response.json())) as { id: string };
		return json.id;
	});

const sendDM = (channelId: string, content: string, botToken: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
					method: 'POST',
					headers: {
						Authorization: `Bot ${botToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ content }),
				}),
			catch: (e) => new NotificationError({ userId: 'unknown', reason: `Failed to call Discord API: ${String(e)}` }),
		});

		if (!response.ok) {
			const text = yield* Effect.tryPromise(() => response.text()).pipe(Effect.orElseSucceed(() => 'Unknown error'));
			return yield* Effect.fail(new NotificationError({ userId: 'unknown', reason: `Discord Send Message Error ${response.status}: ${text}` }));
		}
	});

const formatNotification = (result: LeaveByResult, prefs: UserPrefs, trigger: string) => {
	const urgency = result.predictedFill >= 90 ? '🚨' : result.predictedFill >= 75 ? '⚠️' : '🅿️';
	const [arrH, arrM] = prefs.arrival.split(':').map(Number);
	const arrivalDecimal = arrH + (arrM ?? 0) / 60;
	const lotWontFill = result.estimatedFullTime === null || result.estimatedFullTime >= arrivalDecimal;

	let message = `${urgency} **${result.stationName} Station Parking**\n\n`;

	if (trigger === 'deviation_alert') {
		// This is a re-notification due to unusual conditions
		message += `⚠️ **Busier than usual today**\n`;
		message += `Currently ${Math.round(result.deviation)}pp above typical for this time\n\n`;
	}

	if (lotWontFill && result.predictedFill < 75) {
		message += `You can leave at your usual time (**${result.leaveByFormatted}**)\n\n`;
	} else {
		message += `**Latest you can leave: ${result.leaveByFormatted}**\n`;
		if (result.estimatedFullTime) {
			message += `(to arrive before lot fills at ~${formatDecimalHour(result.estimatedFullTime)})\n`;
		}
		message += '\n';
	}

	if (result.zoneName) {
		const currentGauge = renderGauge(result.currentFill);

		message += `📍 **Your zone (${result.zoneName}):**\n`;
		message += `   ${currentGauge}  ${result.currentFill}%  |  ${result.freeSpots} spots free\n`;
		message += `   At arrival: ~${result.predictedFill}%  |  ~${Math.max(0, Math.round(result.totalSpots * (1 - result.predictedFill / 100)))} spots left\n`;
		if (result.estimatedFullTime) {
			message += `   ⚠️ Full by ~${formatDecimalHour(result.estimatedFullTime)}\n`;
		}

		if (result.alternatives.length > 0) {
			message += `\n📊 **Other zones:**\n`;
			for (const alt of result.alternatives) {
				const color = alt.currentPercent >= 90 ? '🔴' : alt.currentPercent >= 75 ? '🟠' : '🟢';
				let altLine = `   ${color} ${alt.name}: ${alt.currentPercent}% (${alt.freeSpots} free)`;
				if (alt.estimatedFullTime) {
					altLine += ` — full by ~${formatDecimalHour(alt.estimatedFullTime)}`;
				}
				message += altLine + '\n';
			}
		}
	} else {
		const currentGauge = renderGauge(result.currentFill);
		message += `Now: ${currentGauge}  ${result.currentFill}%  |  ${result.freeSpots} spots free\n`;
		message += `At arrival: ~${result.predictedFill}%  |  ~${Math.max(0, Math.round(result.totalSpots * (1 - result.predictedFill / 100)))} spots left\n`;

		if (result.allZones.length > 1) {
			message += `\n📊 **Zones:**\n`;
			for (const zone of result.allZones) {
				const zoneFree = zone.total - zone.occupied;
				const color = zone.percent >= 90 ? '🔴' : zone.percent >= 75 ? '🟠' : '🟢';
				message += `   ${color} ${zone.name}: ${zone.percent}% (${zoneFree} free)\n`;
			}
			message += `\n_Set a preferred zone with \`/setup-zone\` for targeted alerts_\n`;
		}
	}

	message += `\n🚗 Travel: ${result.travelMinutes} mins`;
	if (result.trafficDelay > 0) {
		message += ` (+${result.trafficDelay} mins traffic)`;
	}

	const fillRateText = formatFillRate(result.fillRate, { onlyPositive: true });
	if (fillRateText) {
		message += `\n${fillRateText}`;
	}

	// Show tracking status vs historical baseline
	if (result.deviation > 5) {
		message += `\n\n⚠️ Tracking ${Math.round(result.deviation)}pp above normal for this time`;
	} else if (result.deviation < -5) {
		message += `\n\n✅ Tracking ${Math.abs(Math.round(result.deviation))}pp below normal — quieter than usual`;
	}

	if (result.confidence === 'low') {
		message += `\n\n_Building historical data — predictions will improve_`;
	}

	return message;
};

export const getUsersForNotification = (env: Env) =>
	Effect.gen(function* () {
		const index = yield* Effect.tryPromise(() => env.METRO_KV.get('users_index', 'json'));
		return (index as string[]) ?? [];
	});

export const getUserPrefs = (userId: string, env: Env) =>
	Effect.gen(function* () {
		const raw = yield* Effect.tryPromise(() => env.METRO_KV.get(`user:${userId}`, 'json'));
		if (!raw) return null;

		return yield* Schema.decodeUnknown(UserPrefs)(raw).pipe(
			Effect.catchAll((error) =>
				Console.error(`Schema validation failed for user ${userId}:`, error).pipe(Effect.as(null)),
			),
		);
	});

interface LastNotificationData {
	trigger: string;
	deviation: number;
	leaveByMinutes: number;
	predictedFill: number;
	timestamp: number;
}

const shouldSendNotification = (
	userId: string,
	current: { leaveByMinutes: number; predictedFill: number; deviation: number },
	env: Env,
) =>
	Effect.gen(function* () {
		const lastKey = `last_notification:${userId}`;
		const last = yield* Effect.tryPromise(() => env.METRO_KV.get(lastKey, 'json'));

		// First notification of the day — always send
		if (!last) return { shouldSend: true, trigger: 'first_notification' };

		const lastData = last as LastNotificationData;

		// Deviation alert: current fill is >=10pp above P90 baseline
		// Only re-notify if:
		//   1. Deviation is significant (>=10pp above P90)
		//   2. At least 10 minutes since last notification (cooldown)
		//   3. Either this is a new deviation event, or the situation has worsened further (>=5pp more deviation)
		const timeSinceLast = Date.now() - lastData.timestamp;
		const cooldownPassed = timeSinceLast >= 10 * 60 * 1000;

		if (current.deviation >= 10 && cooldownPassed) {
			const isNewDeviation = lastData.trigger === 'first_notification';
			const hasWorsenedFurther = current.deviation >= lastData.deviation + 5;

			if (isNewDeviation || hasWorsenedFurther) {
				return { shouldSend: true, trigger: 'deviation_alert' };
			}
		}

		return { shouldSend: false, trigger: 'no_change' };
	});

const saveLastNotification = (
	userId: string,
	data: { trigger: string; leaveByMinutes: number; predictedFill: number; deviation: number },
	env: Env,
) =>
	Effect.tryPromise(() =>
		env.METRO_KV.put(`last_notification:${userId}`, JSON.stringify({ ...data, timestamp: Date.now() }), {
			expirationTtl: 60 * 60 * 4,
		}),
	);

export interface UserNotificationResult {
	userId: string;
	outcome: 'sent' | 'skipped' | 'error';
	reason: string;
	station?: string;
	leaveBy?: string;
	currentFill?: number;
	predictedFill?: number;
	travelMinutes?: number;
	trafficDelay?: number;
	zoneName?: string | null;
	fillRate?: string | null;
	trigger?: string;
	dmChannelCached?: boolean;
	errorType?: string;
	deviation?: number;
}

const PEAK_END_HOUR = 9; // Stop notifications at 9am

const processUserNotification = (userId: string, sydney: SydneyTime, env: Env): Effect.Effect<UserNotificationResult, never, never> =>
	Effect.gen(function* () {
		const log: UserNotificationResult = { userId, outcome: 'skipped', reason: '' };

		const prefs = yield* getUserPrefs(userId, env);

		if (!prefs) {
			log.reason = 'no_prefs';
			return log;
		}

		log.station = prefs.station;

		const days = prefs.days.split(',').map((d) => d.trim().substring(0, 3));
		if (!days.includes(sydney.shortDay)) {
			log.reason = `not_scheduled:${sydney.shortDay}`;
			return log;
		}

		const currentHour = sydney.hour + sydney.minute / 60;

		// Stop notification processing after peak hours (9am)
		if (currentHour >= PEAK_END_HOUR) {
			log.reason = 'past_peak_hours';
			return log;
		}

		const [startH, startM] = prefs.notificationStart.split(':').map(Number);
		const notificationStart = startH + startM / 60;

		if (currentHour < notificationStart) {
			log.reason = 'too_early';
			return log;
		}

		const result = yield* calculateLeaveBy(prefs, env, sydney);

		log.leaveBy = result.leaveByFormatted;
		log.currentFill = result.currentFill;
		log.predictedFill = result.predictedFill;
		log.travelMinutes = result.travelMinutes;
		log.trafficDelay = result.trafficDelay;
		log.zoneName = result.zoneName;
		log.fillRate = result.fillRate ? `${result.fillRate.spotsPerMin}/min (${result.fillRate.description})` : null;
		log.deviation = result.deviation;

		if (sydney.date > result.leaveByTime) {
			log.reason = 'deadline_passed';
			return log;
		}

		const leaveByMinutes = result.leaveByTime.getHours() * 60 + result.leaveByTime.getMinutes();
		const { shouldSend, trigger } = yield* shouldSendNotification(
			userId,
			{ leaveByMinutes, predictedFill: result.predictedFill, deviation: result.deviation },
			env,
		);

		log.trigger = trigger;

		if (!shouldSend) {
			log.reason = 'no_significant_change';
			return log;
		}

		let channelId = yield* getCachedDMChannel(userId, env);
		log.dmChannelCached = channelId !== null;

		if (!channelId) {
			channelId = yield* createDMChannel(userId, env.DISCORD_BOT_TOKEN);
			yield* cacheDMChannel(userId, channelId, env);
		}

		const message = formatNotification(result, prefs, trigger);

		yield* sendDM(channelId, message, env.DISCORD_BOT_TOKEN).pipe(
			Effect.catchAll((error) => {
				if (String(error).includes('401') || String(error).includes('403')) {
					return clearCachedDMChannel(userId, env).pipe(
						Effect.flatMap(() => Effect.fail(new NotificationError({
							userId,
							reason: `DM failed with auth error - channel cache cleared`,
						})))
					);
				}
				return Effect.fail(error);
			})
		);

		yield* saveLastNotification(userId, { trigger, leaveByMinutes, predictedFill: result.predictedFill, deviation: result.deviation }, env);

		log.outcome = 'sent';
		log.reason = trigger;
		return log;
	}).pipe(
		Effect.catchAll((error) => {
			const tagged = error as { _tag?: string; reason?: string; message?: string };
			return Effect.succeed({
				userId,
				outcome: 'error' as const,
				reason: tagged.reason ?? tagged.message ?? String(error),
				errorType: tagged._tag ?? 'Unknown',
			});
		}),
	);

export const processNotifications = (env: Env) =>
	Effect.gen(function* () {
		const sydney = getSydneyTime();
		const userIds = yield* getUsersForNotification(env);

		return yield* Effect.forEach(userIds, (userId) => processUserNotification(userId, sydney, env));
	});
