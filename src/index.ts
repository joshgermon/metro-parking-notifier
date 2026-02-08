import { Console, Effect } from 'effect';
import { handleInteraction } from './discord';
import { verifyDiscordSignature } from './signature';

const handleRequest = (request: Request, env: Env) =>
	Effect.gen(function* () {
		const body = yield* Effect.promise(() => request.text());

		const signature = request.headers.get('x-signature-ed25519');
		const timestamp = request.headers.get('x-signature-timestamp');

		const discordPublicKey = env.DISCORD_PUBLIC_KEY;

		if (!signature || !timestamp) {
			return new Response(null, { status: 403 });
		}

		const ok = yield* verifyDiscordSignature(body, signature, timestamp, discordPublicKey);

		if (!ok) return new Response(null, { status: 403 });

		const json = yield* Effect.try({
			try: () => JSON.parse(body),
			catch: () => new Error('Invalid JSON'),
		});

		return yield* handleInteraction(json, env);
	});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const program = handleRequest(request, env).pipe(
			Effect.catchAll((error) => {
				return Console.error('Worker Error:', error).pipe(Effect.map(() => new Response('Internal Server Error', { status: 500 })));
			}),
		);

		return Effect.runPromise(program);
	},
} satisfies ExportedHandler<Env>;
