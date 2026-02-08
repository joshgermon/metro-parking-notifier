
import { Effect } from 'effect';
import { verifyDiscordSignature } from './discord';

const handleRequest = (request: Request, env: Env) =>
	Effect.gen(function*() {
		const body = yield* Effect.promise(() => request.text());

		const signature = request.headers.get('x-signature-ed25519');
		const timestamp = request.headers.get('x-signature-timestamp');

		const discordPublicKey = env.DISCORD_PUBLIC_KEY

		if (!signature || !timestamp) {
			return new Response(null, { status: 403 });
		}

		const ok = yield* verifyDiscordSignature(body, signature, timestamp, discordPublicKey);

		if (!ok) return new Response(null, { status: 403 });

	});


export default {
	async fetch(request, env, ctx): Promise<Response> {
		return new Response('Hello World!');
	},
} satisfies ExportedHandler<Env>;
