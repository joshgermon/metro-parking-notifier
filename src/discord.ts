import { Effect, Match, Schema } from 'effect';
import { checkParking, findSimilarStations, getStationOptions, resolveStationId, type FillRate, type ZoneResult } from './transport';
import { isValidTimeFormat, isValidDayFormat } from './time';
import { UserPrefs } from './calculator';
import { getUserPrefs } from './notification';
import { renderGauge, getStatusText, formatFillRate, formatUpdatedTime, formatZones } from './format';

const DiscordOption = Schema.Struct({
	name: Schema.String,
	value: Schema.optional(Schema.Union(Schema.String, Schema.Number, Schema.Boolean)),
	focused: Schema.optional(Schema.Boolean),
});

const CommandData = Schema.Struct({
	name: Schema.String,
	options: Schema.optional(Schema.Array(DiscordOption)),
});

const CommandInteraction = Schema.Struct({
	type: Schema.Literal(2),
	data: CommandData,
	member: Schema.optional(
		Schema.Struct({
			user: Schema.Struct({
				id: Schema.String,
				username: Schema.String,
			}),
		}),
	),
	user: Schema.optional(
		Schema.Struct({
			id: Schema.String,
			username: Schema.String,
		})
	),
});

const AutocompleteInteraction = Schema.Struct({
	type: Schema.Literal(4),
	data: CommandData,
});

const PingInteraction = Schema.Struct({
	type: Schema.Literal(1),
});

const DiscordInteraction = Schema.Union(PingInteraction, CommandInteraction, AutocompleteInteraction);

type CommandInteraction = Schema.Schema.Type<typeof CommandInteraction>;
type AutocompleteInteraction = Schema.Schema.Type<typeof AutocompleteInteraction>;

const handlePing = () => Effect.succeed(new Response(JSON.stringify({ type: 1 })));

const annotatedLog = (message: string, annotations: Record<string, unknown>) =>
	Object.entries(annotations).reduce(
		(effect, [key, value]) => effect.pipe(Effect.annotateLogs(key, value)),
		Effect.log(message) as Effect.Effect<void>,
	);

const addToUsersIndex = (userId: string, env: Env) =>
	Effect.gen(function* () {
		const existing = yield* Effect.tryPromise(() => env.METRO_KV.get('users_index', 'json'));
		const users = (existing as string[]) ?? [];

		if (!users.includes(userId)) {
			users.push(userId);
			yield* Effect.tryPromise(() => env.METRO_KV.put('users_index', JSON.stringify(users)));
		}
	});

const handleSetup = (cmd: CommandInteraction, env: Env) =>
	Effect.gen(function* () {
		const getValue = (name: string) => cmd.data.options?.find((o) => o.name === name)?.value;
		const userId = cmd.member?.user.id || cmd.user?.id;
		const arrival = getValue('arrival') as string;
		const notificationStart = getValue('notification_start') as string;
		const days = getValue('office_days') as string;
		const rawStation = getValue('station') as string;

		const context = { event: 'setup_command', userId, arrival, notificationStart, days, station: rawStation };

		if (!userId) {
			yield* annotatedLog('Setup Failed', { ...context, outcome: 'failed', reason: 'Could not identify user' });
			return Response.json({ type: 4, data: { content: 'Could not identify user' } });
		}

		const stationId = yield* resolveStationId(rawStation, env);

		const validationError =
			!stationId ? `Invalid station: "${rawStation}". Please select from the autocomplete list.`
			: !isValidTimeFormat(arrival) ? 'Invalid arrival time format'
			: !isValidTimeFormat(notificationStart) ? 'Invalid notification start time format'
			: !isValidDayFormat(days) ? 'Invalid days format'
			: null;

		if (validationError) {
			yield* annotatedLog('Setup Failed', { ...context, outcome: 'failed', reason: validationError });

			const message = validationError.includes('arrival')
				? '❌ Invalid arrival time. Please use 24-hour format HH:MM (e.g., 07:30 or 17:45)'
				: validationError.includes('notification')
				? '❌ Invalid notification start time. Please use 24-hour format HH:MM (e.g., 06:00)'
				: validationError.includes('days')
				? '❌ Invalid days format. Please use comma-separated 3-letter days (e.g., Mon,Tue,Wed)'
				: `❌ ${validationError}`;

			return Response.json({ type: 4, data: { content: message } });
		}

		const prefs = {
			home: getValue('home_address') as string,
			station: stationId!,
			days,
			arrival,
			notificationStart,
			buffer: (getValue('buffer') as number) ?? 10,
			userId,
		};

		const validPrefs = yield* Schema.decodeUnknown(UserPrefs)(prefs).pipe(
			Effect.tapError((error) =>
				annotatedLog('Setup Failed', { ...context, outcome: 'failed', reason: `Schema validation failed: ${error}` })
			),
		);

		yield* Effect.tryPromise(() => env.METRO_KV.put(`user:${userId}`, JSON.stringify(validPrefs)));
		yield* addToUsersIndex(userId, env);

		yield* annotatedLog('Setup Success', { ...context, outcome: 'success', prefs: JSON.stringify(validPrefs) });

		const parkingData = yield* checkParking(stationId!, env).pipe(Effect.orElseSucceed(() => null));

		let zonesInfo = '';
		if (parkingData && parkingData.zones.length > 1) {
			const zoneList = parkingData.zones.map((z, i) =>
				`${i + 1}. **${z.name}** (${z.total} spots)`
			).join('\n');
			zonesInfo = `\n\nThis station has multiple parking zones:\n${zoneList}\n\nUse \`/setup-zone\` to target a specific zone, or leave it to track the whole station.`;
		}

		return Response.json({
			type: 4,
			data: {
				content:
					`Setup saved!\n\n` +
					`Station: ${rawStation}\n` +
					`Days: ${prefs.days}\n` +
					`Arrival: ${prefs.arrival}\n` +
					`Notifications from: ${prefs.notificationStart}\n` +
					`Buffer: ${prefs.buffer} mins` +
					zonesInfo,
			},
		});
	});

const handleSetupZone = (cmd: CommandInteraction, env: Env) =>
	Effect.gen(function* () {
		const getValue = (name: string) => cmd.data.options?.find((o) => o.name === name)?.value;
		const userId = cmd.member?.user.id || cmd.user?.id;

		if (!userId) {
			return Response.json({ type: 4, data: { content: 'Could not identify user' } });
		}

		const prefs = yield* getUserPrefs(userId, env);
		if (!prefs) {
			return Response.json({ type: 4, data: { content: '❌ Please run `/setup` first to configure your station.' } });
		}

		const zoneName = getValue('zone') as string;

		if (!zoneName) {
			const updatedPrefs = { ...prefs, preferredZone: undefined };
			yield* Effect.tryPromise(() => env.METRO_KV.put(`user:${userId}`, JSON.stringify(updatedPrefs)));

			const parkingData = yield* checkParking(prefs.station, env).pipe(Effect.orElseSucceed(() => null));
			let zonesInfo = 'Preferred zone cleared. Notifications will track the whole station.';
			if (parkingData && parkingData.zones.length > 0) {
				const zoneList = parkingData.zones.map((z, i) =>
					`${i + 1}. **${z.name}** (${z.total} spots, ${z.percent}% full)`
				).join('\n');
				zonesInfo += `\n\nAvailable zones:\n${zoneList}`;
			}

			return Response.json({ type: 4, data: { content: zonesInfo } });
		}

		const parkingData = yield* checkParking(prefs.station, env).pipe(Effect.orElseSucceed(() => null));
		if (!parkingData || parkingData.zones.length === 0) {
			return Response.json({
				type: 4,
				data: { content: '❌ No zone data available for your station. Zone preferences require the station to have multiple parking zones.' },
			});
		}

		const matchedZone = parkingData.zones.find(z => z.name.toLowerCase() === zoneName.toLowerCase());
		if (!matchedZone) {
			const available = parkingData.zones.map(z => `• ${z.name}`).join('\n');
			return Response.json({
				type: 4,
				data: { content: `❌ Zone "${zoneName}" not found at ${parkingData.name}.\n\nAvailable zones:\n${available}` },
			});
		}

		const updatedPrefs = { ...prefs, preferredZone: matchedZone.name };
		yield* Effect.tryPromise(() => env.METRO_KV.put(`user:${userId}`, JSON.stringify(updatedPrefs)));

		yield* annotatedLog('Setup Zone Success', { userId, zone: matchedZone.name, station: prefs.station });

		const otherZones = parkingData.zones
			.filter(z => z.name !== matchedZone.name)
			.map(z => {
				const color = z.percent >= 90 ? '🔴' : z.percent >= 75 ? '🟠' : '🟢';
				return `${color} ${z.name}: ${z.percent}% (${z.total - z.occupied} free)`;
			})
			.join('\n');

		let content = `✅ Preferred zone set to **${matchedZone.name}**\n\n`;
		content += `📍 ${matchedZone.name}: ${matchedZone.percent}% full (${matchedZone.total - matchedZone.occupied} spots free)\n`;
		if (otherZones) {
			content += `\nOther zones (shown as alternatives in notifications):\n${otherZones}`;
		}

		return Response.json({ type: 4, data: { content } });
	});

const handleCarpark = (cmd: CommandInteraction, env: Env) =>
	Effect.gen(function* () {
		const getValue = (name: string) => cmd.data.options?.find((o) => o.name === name)?.value;
		const rawStation = getValue('station') as string;
		const userId = cmd.member?.user.id || cmd.user?.id;

		const context = { event: 'carpark_command', userId, station: rawStation };

		if (!rawStation) {
			yield* annotatedLog('Carpark Check Failed', { ...context, outcome: 'failed', reason: 'Missing station name' });
			return Response.json({ type: 4, data: { content: 'Please specify a station name' } });
		}

		const stationId = yield* resolveStationId(rawStation, env);

		if (!stationId) {
			const stations = yield* getStationOptions(env).pipe(Effect.orElseSucceed(() => [] as { name: string, id: string }[]));
			const suggestions = findSimilarStations(rawStation, stations.map(s => s.name), 3);

			const suggestionText =
				suggestions.length > 0 ? `\n\nDid you mean?\n${suggestions.map((s) => `• ${s}`).join('\n')}` : '';

			return Response.json({
				type: 4,
				data: { content: `Station "${rawStation}" not found.${suggestionText}\n\nTip: Use autocomplete for the full station list.` },
			});
		}

		const parking = yield* checkParking(stationId, env);

		yield* annotatedLog('Carpark Check Success', {
			...context, outcome: 'success', percent: parking.percent, free: parking.free, total: parking.total,
		});

		const urgency = parking.percent >= 90 ? '🚨' : parking.percent >= 75 ? '⚠️' : '🅿️';
		const gauge = renderGauge(parking.percent);
		const status = getStatusText(parking.percent);
		const fillRateText = formatFillRate(parking.fillRate);
		const updatedText = formatUpdatedTime(parking.lastUpdated);
		const zonesText = formatZones(parking.zones);

		const content =
			`${urgency} **${parking.name} Station Parking**\n\n` +
			`${gauge}  ${parking.percent}%\n\n` +
			`🚗 Free Spots: ${parking.free} / ${parking.total}\n` +
			(zonesText ? `${zonesText}\n` : '') +
			(fillRateText ? `${fillRateText}\n` : '') +
			`⏰ Updated: ${updatedText}\n\n` +
			`Status: ${status}`;

		return Response.json({ type: 4, data: { content } });
	});

const handleAutocomplete = (interaction: AutocompleteInteraction, env: Env) =>
	Effect.gen(function* () {
		const focusedOption = interaction.data.options?.find((o) => o.focused);
		if (!focusedOption || focusedOption.name !== 'station') {
			return Response.json({ type: 8, data: { choices: [] } });
		}

		const query = String(focusedOption.value ?? '').toLowerCase();
		const stations = yield* getStationOptions(env).pipe(Effect.orElseSucceed(() => [] as { name: string, id: string }[]));

		const filtered = stations
			.filter((s) => s.name.toLowerCase().includes(query))
			.slice(0, 25)
			.map((s) => ({ name: s.name, value: s.id }));

		return Response.json({ type: 8, data: { choices: filtered } });
	});

const handleCommand = (cmd: CommandInteraction, env: Env) =>
	Match.value(cmd.data.name).pipe(
		Match.when('setup', () => handleSetup(cmd, env)),
		Match.when('setup-zone', () => handleSetupZone(cmd, env)),
		Match.when('carpark', () => handleCarpark(cmd, env)),
		Match.orElse(() =>
			Effect.succeed(Response.json({ type: 4, data: { content: 'Unknown command' } })),
		),
	);

export const handleInteraction = (json: unknown, env: Env) =>
	Effect.gen(function* () {
		const interaction = Schema.decodeUnknownSync(DiscordInteraction)(json);

		return yield* Match.value(interaction).pipe(
			Match.when({ type: 1 }, handlePing),
			Match.when({ type: 2 }, (cmd) => handleCommand(cmd, env)),
			Match.when({ type: 4 }, (ac) => handleAutocomplete(ac, env)),
			Match.exhaustive,
		);
	});
