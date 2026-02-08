import { Console, Effect, Match, Schema } from 'effect';

const DiscordOption = Schema.Struct({
	name: Schema.String,
	value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
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
});

const PingInteraction = Schema.Struct({
	type: Schema.Literal(1),
});

const DiscordInteraction = Schema.Union(PingInteraction, CommandInteraction);

type DiscordInteraction = Schema.Schema.Type<typeof DiscordInteraction>;

type CommandInteraction = Schema.Schema.Type<typeof CommandInteraction>;

const handlePing = () => Effect.succeed(new Response(JSON.stringify({ type: 1 })));

const handleCommand = (cmd: CommandInteraction, env: Env) =>
	Effect.gen(function* () {
		const getValue = (name: string) => cmd.data.options?.find((o) => o.name === name)?.value;

		const prefs = {
			home: getValue('home_address'),
			station: getValue('station'),
			days: getValue('office_days'),
			arrival: getValue('arrival'),
		};

		yield* Console.log('Saving prefs:', prefs);

		yield* Effect.tryPromise(() => env.METRO_KV.put('user_prefs', JSON.stringify(prefs)));

		return Response.json({
			type: 4,
			data: { content: 'Setup saved successfully' },
		});
	});

export const handleInteraction = (json: unknown, env: Env) =>
	Effect.gen(function* () {
		const interaction = Schema.decodeUnknownSync(DiscordInteraction)(json);

		return yield* Match.value(interaction).pipe(
			Match.when({ type: 1 }, handlePing),
			Match.when({ type: 2 }, (cmd) => handleCommand(cmd, env)),
			Match.exhaustive,
		);
	});
