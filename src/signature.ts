import { Effect } from 'effect';

const hexToUint8Array = (hex: string): Uint8Array => {
	const len = hex.length;
	const out = new Uint8Array(len / 2);

	for (let i = 0, j = 0; i < len; i += 2, j++) {
		out[j] =
			(hex.charCodeAt(i) > 57 ? hex.charCodeAt(i) - 87 : hex.charCodeAt(i) - 48) * 16 +
			(hex.charCodeAt(i + 1) > 57 ? hex.charCodeAt(i + 1) - 87 : hex.charCodeAt(i + 1) - 48);
	}

	return out;
};

export const verifyDiscordSignature = (body: string, signature: string, timestamp: string, publicKey: string) =>
	Effect.tryPromise(async () => {
		const key = await crypto.subtle.importKey(
			'raw',
			hexToUint8Array(publicKey),
			{ name: 'Ed25519', namedCurve: 'Ed25519' },
			false,
			['verify'],
		);

		const isValid = await crypto.subtle.verify(
			'Ed25519',
			key,
			hexToUint8Array(signature),
			new TextEncoder().encode(timestamp + body),
		);

		return isValid;
	});
