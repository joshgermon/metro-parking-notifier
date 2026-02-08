import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Metro Parking Worker', () => {
	it('rejects requests without Discord signature headers', async () => {
		const request = new IncomingRequest('http://example.com', {
			method: 'POST',
			body: JSON.stringify({ type: 1 }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('rejects GET requests', async () => {
		const request = new IncomingRequest('http://example.com', {
			method: 'GET',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});
});
