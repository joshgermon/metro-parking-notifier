import { Console, Effect, Schema } from 'effect';

const OptionType = {
	STRING: 3,
	INTEGER: 4,
} as const;


const CommandOption = Schema.Struct({
	type: Schema.Number,
	name: Schema.String,
	description: Schema.String,
	required: Schema.optional(Schema.Boolean),
	autocomplete: Schema.optional(Schema.Boolean),
});

const Command = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	options: Schema.optional(Schema.Array(CommandOption)),
});

type Command = Schema.Schema.Type<typeof Command>;

const COMMANDS: Command[] = [
	{
		name: 'carpark',

		description: 'Check current parking availability at a station',
		options: [
			{
				type: OptionType.STRING,
				name: 'station',
				description: 'Station to check',
				required: true,
				autocomplete: true,
			},
		],
	},
	{
		name: 'setup',
		description: 'Configure your parking notification preferences',
		options: [
			{
				type: OptionType.STRING,
				name: 'home_address',
				description: 'Your home address for travel time calculation',
				required: true,
			},
			{
				type: OptionType.STRING,
				name: 'station',
				description: 'Your target station',
				required: true,
				autocomplete: true,
			},
			{
				type: OptionType.STRING,
				name: 'office_days',
				description: 'Days you commute (e.g., Mon,Tue,Wed,Thu,Fri)',
				required: true,
			},
			{
				type: OptionType.STRING,
				name: 'arrival',
				description: 'Target arrival time at station (e.g., 07:30)',
				required: true,
			},
			{
				type: OptionType.STRING,
				name: 'notification_start',
				description: 'When to start receiving notifications (e.g., 06:30)',
				required: true,
			},
			{
				type: OptionType.INTEGER,
				name: 'buffer',
				description: 'Minutes of cushion before lot fills (default: 10)',
				required: false,
			},
		],
	},
	{
		name: 'setup-zone',
		description: 'Set your preferred parking zone (run /setup first)',
		options: [
			{
				type: OptionType.STRING,
				name: 'zone',
				description: 'Zone name (e.g., North). Leave empty to clear and see available zones.',
				required: false,
			},
		],
	},
];

const registerWithDiscord = (commands: Command[], appId: string, botToken: string) =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
					method: 'PUT',
					headers: {
						Authorization: `Bot ${botToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(commands),
				}),
			catch: (e) => new Error(`Discord API request failed: ${e}`),
		});

		if (!response.ok) {
			const error = yield* Effect.tryPromise(() => response.text());
			return yield* Effect.fail(new Error(`Discord API error: ${response.status} ${error}`));
		}

		return yield* Effect.tryPromise(() => response.json());
	});

const registerCommands = Effect.gen(function* () {
	const appId = process.env.DISCORD_APP_ID;
	const botToken = process.env.DISCORD_BOT_TOKEN;

	if (!appId) return yield* Effect.fail(new Error('Missing DISCORD_APP_ID in .dev.vars'));
	if (!botToken) return yield* Effect.fail(new Error('Missing DISCORD_BOT_TOKEN in .dev.vars'));

	yield* Console.log(`Registering ${COMMANDS.length} commands with Discord...`);

	yield* registerWithDiscord(COMMANDS, appId, botToken);

	yield* Console.log('Commands registered successfully!');
});

Effect.runPromise(registerCommands).catch((e) => {
	console.error('Registration failed:', e.message);
	process.exit(1);
});
