import { Effect } from "effect"

const hexToBin = (hex: string): Uint8Array => {
	const len = hex.length
	const out = new Uint8Array(len / 2)

	for (let i = 0, j = 0; i < len; i += 2, j++) {
		out[j] =
			(hex.charCodeAt(i) > 57 ? hex.charCodeAt(i) - 87 : hex.charCodeAt(i) - 48) * 16 +
			(hex.charCodeAt(i + 1) > 57 ? hex.charCodeAt(i + 1) - 87 : hex.charCodeAt(i + 1) - 48)
	}

	return out
}

const importKey = (keyBuf: Uint8Array) =>
	Effect.promise(() =>
		crypto.subtle.importKey("raw", keyBuf, { name: "NODE_ED25519" }, false, ["verify"])
	)

const verifySig = (
	cryptoKey: CryptoKey,
	sigBuf: Uint8Array,
	msgBuf: Uint8Array
) =>
	Effect.promise(() =>
		crypto.subtle.verify("NODE_ED25519", cryptoKey, sigBuf, msgBuf)
	)


export const verifyDiscordSignature = (
	body: string,
	signature: string,
	timestamp: string,
	key: string,
) =>
	Effect.gen(function*() {
		const keyBuf = hexToBin(key);
		const sigBuf = hexToBin(signature);
		const msgBuf = new TextEncoder().encode(timestamp + body);

		const cryptoKey = yield* importKey(keyBuf);

		return yield* verifySig(cryptoKey, sigBuf, msgBuf)
	});
