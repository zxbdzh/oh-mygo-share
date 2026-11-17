import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createShareApi } from './share-api';

const metadata = {
	title: 'Blue Hour',
	artists: 'A. Example',
	sourceId: 'catalog',
	trackId: 'track-1',
	quality: 'high',
	template: 'cinema',
	cardSquare: false,
	mode: 'full',
	durationMs: 180_000,
	lyrics: [],
	selectedLineIndexes: []
};

describe('share management HTTP API', () => {
	let directory: string;
	let api: ReturnType<typeof createShareApi>;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'oh-mygo-share-'));
		api = createShareApi({
			databasePath: join(directory, 'shares.sqlite'),
			mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token'
		});
	});

	afterEach(async () => {
		await api.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('reuses an identical published snapshot without renewing or opening it', async () => {
		await api.close();
		let clock = new Date('2026-11-17T00:00:00Z');
		const options = {
			databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token', now: () => new Date(clock),
			mediaProcessor: async (source: string, output: string) => {
				await copyFile(source, output);
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		};
		api = createShareApi(options);
		const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
		const lookup = (authorized = true) => api.fetch(new Request('http://share.test/api/shares/reuse', {
			method: 'POST', headers: authorized ? headers : { 'content-type': 'application/json' },
			body: JSON.stringify(metadata)
		}));
		expect((await lookup(false)).status).toBe(401);
		expect((await lookup()).status).toBe(204);
		const created = await api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'idempotency-key': 'reusable-snapshot' },
			body: JSON.stringify(metadata)
		}));
		const share = await created.json();
		await api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, {
			method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3, 4])
		}));
		await expect.poll(async () => (await lookup()).status).toBe(200);
		const original = await (await lookup()).json();
		await api.close();
		clock = new Date('2026-11-17T01:00:00Z');
		api = createShareApi(options);
		const reused = await (await lookup()).json();
		expect(reused.id).toBe(share.id);
		expect(reused.url).toBe(original.url);
		expect(reused.expiresAt).toBe(original.expiresAt);
		expect(reused.lastOpenedAt).toBeUndefined();
		const listing = await (await api.fetch(new Request('http://share.test/api/shares', { headers }))).json();
		expect(listing.shares).toHaveLength(1);
	});

	it('never reuses changed, unfinished, revoked or expired shares', async () => {
		await api.close();
		let clock = new Date('2026-11-17T00:00:00Z');
		api = createShareApi({
			databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token', now: () => new Date(clock),
			mediaProcessor: async (source, output) => {
				await copyFile(source, output);
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});
		const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
		const lookup = (snapshot: unknown = metadata) => api.fetch(new Request('http://share.test/api/shares/reuse', {
			method: 'POST', headers, body: JSON.stringify(snapshot)
		}));
		const create = async (key: string) => (await api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(metadata)
		}))).json();
		const publish = async (id: string) => {
			await api.fetch(new Request(`http://share.test/api/shares/${id}/audio`, {
				method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3])
			}));
			await expect.poll(async () => (await lookup()).status).toBe(200);
		};
		const first = await create('reuse-lifecycle-1');
		expect((await lookup()).status).toBe(204);
		await publish(first.id);
		for (const change of [
			{ quality: 'lossless' }, { trackId: 'another' }, { accountId: 'another' },
			{ playbackId: 'another' }, { template: 'minimal' }, { cardSquare: true },
			{ coverHash: 'a'.repeat(64) }, { sourceId: 'another' },
			{ lyrics: [{ text: 'Changed lyrics', atMs: 1000, endMs: 2000 }], selectedLineIndexes: [0] },
			{ mode: 'clip', clipStartMs: 0, clipEndMs: 3000,
				lyrics: [{ text: 'Clip', atMs: 1000, endMs: 2000 }], selectedLineIndexes: [0] }
		]) {
			expect((await lookup({ ...metadata, ...change })).status, JSON.stringify(change)).toBe(204);
		}
		await api.fetch(new Request(`http://share.test/api/shares/${first.id}`, { method: 'DELETE', headers }));
		expect((await lookup()).status).toBe(204);
		const second = await create('reuse-lifecycle-2');
		await publish(second.id);
		clock = new Date('2026-11-18T00:00:00Z');
		expect((await lookup()).status).toBe(204);
		expect((await api.fetch(new Request('http://share.test/api/shares/reuse', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata)
		}))).status).toBe(401);
		expect((await lookup({ title: 'invalid' })).status).toBe(400);
	});

	it('keeps original word timing in published lyrics for the web stage', async () => {
		await api.close();
		api = createShareApi({
			databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token',
			mediaProcessor: async (source, output) => {
				await copyFile(source, output);
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});
		const words = [{ text: 'Blue ', startMs: 1100, endMs: 1800 }, { text: 'hour', startMs: 2400, endMs: 3800 }];
		const hotComments = [{ text: 'Keep this moment', author: 'Listener', likes: 12 }];
		const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
		const created = await api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'idempotency-key': 'stage-timing' },
			body: JSON.stringify({ ...metadata, hotComments, lyrics: [{ text: 'Blue hour', atMs: 1000, endMs: 4000, words }] })
		}));
		expect(created.status).toBe(201);
		const share = await created.json();
		await api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, {
			method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3, 4])
		}));
		let detail: { url?: string; status?: string } = {};
		await expect.poll(async () => {
			detail = await (await api.fetch(new Request(`http://share.test/api/shares/${share.id}`, { headers }))).json();
			return detail.status;
		}).toBe('ready');
		const token = new URL(detail.url!).pathname.split('/').at(-1);
		const published = await (await api.fetch(new Request(`http://share.test/api/public/${token}`))).json();
		expect(published.lyrics[0].words).toEqual(words);
		expect(published.hotComments).toEqual(hotComments);
	});

	it('does not keep a paused session alive with repeated pause events or range reads', async () => {
		await api.close();
		let clock = new Date('2026-11-17T00:00:00Z');
		api = createShareApi({
			databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token', now: () => new Date(clock),
			mediaProcessor: async (source, output) => {
				await copyFile(source, output);
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});
		const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
		const created = await api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'idempotency-key': 'paused-session-regression' }, body: JSON.stringify(metadata)
		}));
		const share = await created.json();
		await api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, {
			method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3, 4])
		}));
		let detail: { status?: string; url?: string } = {};
		await expect.poll(async () => {
			detail = await (await api.fetch(new Request(`http://share.test/api/shares/${share.id}`, { headers }))).json();
			return detail.status;
		}).toBe('ready');
		const token = new URL(detail.url!).pathname.split('/').at(-1);
		const base = `http://share.test/api/public/${token}`;
		const session = await (await api.fetch(new Request(`${base}/sessions`, { method: 'POST' }))).json();
		const pause = () => api.fetch(new Request(`${base}/sessions/${session.sessionId}/activity`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playing: false })
		}));
		expect((await pause()).status).toBe(204);
		clock = new Date('2026-11-17T00:14:00Z');
		expect((await pause()).status).toBe(204);
		const ranged = await api.fetch(new Request(`${base}/audio?session=${session.sessionId}`, { headers: { range: 'bytes=0-1' } }));
		expect(ranged.status).toBe(206);
		await ranged.arrayBuffer();
		clock = new Date('2026-11-17T00:15:00Z');
		expect((await pause()).status).toBe(410);
	});

	it('clips word timestamps to the published audio and rejects invalid word order', async () => {
		const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
		const create = (body: unknown, key: string) => api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(body)
		}));
		const invalid = await create({ ...metadata, lyrics: [{
			text: 'Invalid', atMs: 1000, endMs: 4000,
			words: [{ text: 'later', startMs: 2400, endMs: 3000 }, { text: 'earlier', startMs: 1200, endMs: 1800 }]
		}] }, 'invalid-stage-order');
		expect(invalid.status).toBe(400);
		await api.close();
		api = createShareApi({
			databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token',
			mediaProcessor: async (source, output) => {
				await copyFile(source, output);
				return { mimeType: 'audio/mpeg', durationMs: 3000 };
			}
		});
		const created = await create({
			...metadata, mode: 'clip', clipStartMs: 2000, clipEndMs: 5000, selectedLineIndexes: [1],
			lyrics: [
				{ text: 'A crossing line', atMs: 1000, endMs: 3500, words: [
					{ text: 'outside ', startMs: 1200, endMs: 1800 },
					{ text: 'crossing ', startMs: 1900, endMs: 2300 },
					{ text: 'inside', startMs: 3100, endMs: 3400 }
				] },
				{ text: 'Selected', atMs: 3000, endMs: 4000 }
			]
		}, 'clip-stage-timing');
		expect(created.status).toBe(201);
		const share = await created.json();
		await api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, {
			method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3, 4])
		}));
		let detail: { url?: string; status?: string } = {};
		await expect.poll(async () => {
			detail = await (await api.fetch(new Request(`http://share.test/api/shares/${share.id}`, { headers }))).json();
			return detail.status;
		}).toBe('ready');
		const token = new URL(detail.url!).pathname.split('/').at(-1);
		const published = await (await api.fetch(new Request(`http://share.test/api/public/${token}`))).json();
		expect(published.lyrics[0].words).toEqual([
			{ text: 'crossing ', startMs: 0, endMs: 300 }, { text: 'inside', startMs: 1100, endMs: 1400 }
		]);
	});

	it('refuses share creation without the service management token', async () => {
		const response = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': 'request-1'
				},
				body: JSON.stringify(metadata)
			})
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'unauthorized' });
	});

	it('refuses audio that cannot fit the configured storage budget before processing', async () => {
		await api.close();
		api = createShareApi({ databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'), adminToken: 'local-test-token', maxStorageBytes: 4 });
		const headers = { authorization: 'Bearer local-test-token' };
		const created = await api.fetch(new Request('http://share.test/api/shares', {
			method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'storage-limit-regression' }, body: JSON.stringify(metadata)
		}));
		const share = await created.json();
		const response = await api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, {
			method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg', 'content-length': '5' }, body: new Uint8Array([1, 2, 3, 4, 5])
		}));
		expect(response.status).toBe(507);
		expect(await response.json()).toEqual({ error: 'storage_limit_exceeded' });
		expect(await readdir(join(directory, 'media'))).toEqual([]);
	});

	it('refuses a second upload while the configured processor slot is occupied', async () => {
		await api.close();
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => { finish = resolve; });
		api = createShareApi({ databasePath: join(directory, 'shares.sqlite'), mediaDirectory: join(directory, 'media'), adminToken: 'local-test-token', maxConcurrentJobs: 1,
			mediaProcessor: async (source, output) => { await blocked; await copyFile(source, output); return { mimeType: 'audio/mpeg', durationMs: 180000 }; }
		});
		try {
			const headers = { authorization: 'Bearer local-test-token', 'content-type': 'application/json' };
			const upload = async (key: string) => {
				const created = await api.fetch(new Request('http://share.test/api/shares', { method: 'POST', headers: { ...headers, 'idempotency-key': key }, body: JSON.stringify(metadata) }));
				const share = await created.json();
				return api.fetch(new Request(`http://share.test/api/shares/${share.id}/audio`, { method: 'PUT', headers: { ...headers, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1,2,3,4]) }));
			};
			expect((await upload('concurrency-first')).status).toBe(202);
			const refused = await upload('concurrency-second');
			expect(refused.status).toBe(429);
			expect(await refused.json()).toEqual({ error: 'processing_busy' });
		} finally { finish(); }
	});

	it('rejects an audio clip range that does not include selected lyrics and padding', async () => {
		const clip = {
			...metadata,
			mode: 'clip',
			durationMs: 30_000,
			lyrics: [
				{ text: 'First selected line', atMs: 2_000, endMs: 3_000 },
				{ text: 'Between selected lines', atMs: 4_000, endMs: 5_000 },
				{ text: 'Last selected line', atMs: 8_000, endMs: 9_000 }
			],
			selectedLineIndexes: [0, 2],
			clipStartMs: 1_001,
			clipEndMs: 10_000
		};
		const response = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					authorization: 'Bearer local-test-token',
					'content-type': 'application/json',
					'idempotency-key': 'invalid-clip-1'
				},
				body: JSON.stringify(clip)
			})
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_metadata', field: 'clipRange' });
	});

	it('accepts a continuous clip that spans unselected lines with one second padding', async () => {
		const clip = {
			...metadata,
			mode: 'clip',
			durationMs: 30_000,
			lyrics: [
				{ text: 'First selected line', atMs: 2_000, endMs: 3_000 },
				{ text: 'Between selected lines', atMs: 4_000, endMs: 5_000 },
				{ text: 'Last selected line', atMs: 8_000, endMs: 9_000 }
			],
			selectedLineIndexes: [0, 2],
			clipStartMs: 1_000,
			clipEndMs: 10_000
		};
		const response = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					authorization: 'Bearer local-test-token',
					'content-type': 'application/json',
					'idempotency-key': 'valid-clip-1'
				},
				body: JSON.stringify(clip)
			})
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			status: 'awaiting_upload',
			metadata: { mode: 'clip', clipStartMs: 1000, clipEndMs: 10000 }
		});
	});

	it('accepts a full-song share before probing supplies the actual media duration', async () => {
		const metadataWithoutDuration = {
			...metadata,
			durationMs: 0,
			lyrics: [{ text: 'Timed lyric', atMs: 1_000, endMs: 6_000 }]
		};
		const response = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					authorization: 'Bearer local-test-token',
					'content-type': 'application/json',
					'idempotency-key': 'full-without-duration'
				},
				body: JSON.stringify(metadataWithoutDuration)
			})
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			status: 'awaiting_upload',
			metadata: { mode: 'full', durationMs: 0 }
		});
	});

	it('creates a share once when the client retries the same request', async () => {
		const request = () =>
			api.fetch(
				new Request('http://share.test/api/shares', {
					method: 'POST',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'application/json',
						'idempotency-key': 'request-2'
					},
					body: JSON.stringify(metadata)
				})
			);

		const first = await request();
		const retried = await request();
		const firstBody = await first.json();

		expect(first.status).toBe(201);
		expect(retried.status).toBe(200);
		expect(await retried.json()).toEqual(firstBody);
		expect(firstBody).toMatchObject({
			status: 'awaiting_upload',
			metadata
		});
		const changedQuality = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					authorization: 'Bearer local-test-token',
					'content-type': 'application/json',
					'idempotency-key': 'request-2'
				},
				body: JSON.stringify({ ...metadata, quality: 'lossless' })
			})
		);
		expect(changedQuality.status).toBe(409);
	});

	it('lists shares and lets the owner revoke a pending share', async () => {
		const created = await api.fetch(
			new Request('http://share.test/api/shares', {
				method: 'POST',
				headers: {
					authorization: 'Bearer local-test-token',
					'content-type': 'application/json',
					'idempotency-key': 'management-request-1'
				},
				body: JSON.stringify(metadata)
			})
		);
		const share = await created.json();

		const list = await api.fetch(
			new Request('http://share.test/api/shares', {
				headers: { authorization: 'Bearer local-test-token' }
			})
		);
		expect(list.status).toBe(200);
		expect(await list.json()).toMatchObject({
			shares: [{ id: share.id, status: 'awaiting_upload' }]
		});

		const revoked = await api.fetch(
			new Request(`http://share.test/api/shares/${share.id}`, {
				method: 'DELETE',
				headers: { authorization: 'Bearer local-test-token' }
			})
		);
		expect(revoked.status).toBe(204);

		const detail = await api.fetch(
			new Request(`http://share.test/api/shares/${share.id}`, {
				headers: { authorization: 'Bearer local-test-token' }
			})
		);
		expect((await detail.json()).status).toBe('revoked');
	});

	it('publishes the listen page only after its uploaded audio is processed', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'oh-mygo-share-upload-'));
		let currentTime = new Date('2026-11-16T00:00:00.000Z');
		const uploadApi = createShareApi({
			databasePath: join(directory, 'shares.sqlite'),
			mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token',
			publicOrigin: 'https://share.example',
			now: () => new Date(currentTime),
			maxUploadBytes: 16,
			mediaProcessor: async (sourcePath: string, outputPath: string) => {
				await copyFile(sourcePath, outputPath);
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});

		try {
			const created = await uploadApi.fetch(
				new Request('http://share.test/api/shares', {
					method: 'POST',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'application/json',
						'idempotency-key': 'upload-request-1'
					},
					body: JSON.stringify(metadata)
				})
			);
			const share = await created.json();
			const coverBytes = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00
			]);
			const coverUpload = await uploadApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/cover`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'image/png'
					},
					body: coverBytes
				})
			);
			expect(coverUpload.status).toBe(201);
			const repeatedCover = await uploadApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/cover`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'image/png'
					},
					body: coverBytes
				})
			);
			expect(repeatedCover.status).toBe(200);
			const changedCover = await uploadApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/cover`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'image/png'
					},
					body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
				})
			);
			expect(changedCover.status).toBe(409);

			const uploaded = await uploadApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/audio`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'audio/mpeg'
					},
					body: new Uint8Array([1, 2, 3, 4])
				})
			);
			expect(uploaded.status).toBe(202);
			expect(await uploaded.json()).toEqual({ id: share.id, status: 'processing' });

			let detailResponse: Response | undefined;
			for (let attempt = 0; attempt < 100; attempt++) {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				detailResponse = await uploadApi.fetch(
					new Request(`http://share.test/api/shares/${share.id}`, {
						headers: { authorization: 'Bearer local-test-token' }
					})
				);
				if ((await detailResponse.clone().json()).status === 'ready') break;
			}

			expect(detailResponse?.status).toBe(200);
			const detail = await detailResponse?.json();
			expect(detail).toMatchObject({ status: 'ready' });
			expect(detail.url).toMatch(/^https:\/\/share\.example\/s\//);
			expect(detail).not.toHaveProperty('mediaPath');

			const token = new URL(detail.url).pathname.split('/').at(-1);
			const page = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}`)
			);
			expect(page.status).toBe(200);
			expect(await page.json()).toMatchObject({
				title: metadata.title,
				artists: metadata.artists,
				mode: 'full',
				coverUrl: `/api/public/${token}/cover`,
				audioUrl: `/api/public/${token}/audio`
			});
			const idempotentRetry = await uploadApi.fetch(
				new Request('http://share.test/api/shares', {
					method: 'POST',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'application/json',
						'idempotency-key': 'upload-request-1'
					},
					body: JSON.stringify(metadata)
				})
			);
			expect(idempotentRetry.status).toBe(200);
			expect((await idempotentRetry.json()).url).toBe(detail.url);
			const coverResponse = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/cover`)
			);
			expect(coverResponse.status).toBe(200);
			expect(coverResponse.headers.get('content-type')).toBe('image/png');
			expect(new Uint8Array(await coverResponse.arrayBuffer())).toEqual(coverBytes);

			const opened = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/sessions`, { method: 'POST' })
			);
			expect(opened.status).toBe(201);
			const session = await opened.json();

			const unboundAudio = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/audio`)
			);
			expect(unboundAudio.status).toBe(401);

			const rangedAudio = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/audio?session=${session.sessionId}`, {
					headers: { range: 'bytes=1-2' }
				})
			);
			expect(rangedAudio.status).toBe(206);
			expect(rangedAudio.headers.get('content-range')).toBe('bytes 1-2/4');
			expect([...new Uint8Array(await rangedAudio.arrayBuffer())]).toEqual([2, 3]);

			const revoked = await uploadApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}`, {
					method: 'DELETE',
					headers: { authorization: 'Bearer local-test-token' }
				})
			);
			expect(revoked.status).toBe(204);

			const newSession = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/sessions`, { method: 'POST' })
			);
			expect(newSession.status).toBe(410);

			currentTime = new Date('2026-11-16T00:14:59.000Z');
			const activity = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/sessions/${session.sessionId}/activity`, {
					method: 'POST',
					body: JSON.stringify({ playing: true }),
					headers: { 'content-type': 'application/json' }
				})
			);
			expect(activity.status).toBe(204);

			currentTime = new Date('2026-11-16T00:14:59.000Z');
			const activeAudio = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/audio?session=${session.sessionId}`, {
					headers: { range: 'bytes=0-1' }
				})
			);
			expect(activeAudio.status).toBe(206);

			currentTime = new Date('2026-11-16T00:29:59.000Z');
			const idleAudio = await uploadApi.fetch(
				new Request(`http://share.test/api/public/${token}/audio?session=${session.sessionId}`)
			);
			expect(idleAudio.status).toBe(410);
		} finally {
			await uploadApi.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('renews expiry only after an explicit page-open event and cannot revive an expired link', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'oh-mygo-share-expiry-'));
		let currentTime = new Date('2026-11-16T00:00:00.000Z');
		let resolveProcessing!: () => void;
		const processingComplete = new Promise<void>((resolve) => {
			resolveProcessing = resolve;
		});
		const expiryApi = createShareApi({
			databasePath: join(directory, 'shares.sqlite'),
			mediaDirectory: join(directory, 'media'),
			adminToken: 'local-test-token',
			publicOrigin: 'https://share.example',
			now: () => new Date(currentTime),
			mediaProcessor: async (sourcePath: string, outputPath: string) => {
				await copyFile(sourcePath, outputPath);
				resolveProcessing();
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});

		try {
			const created = await expiryApi.fetch(
				new Request('http://share.test/api/shares', {
					method: 'POST',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'application/json',
						'idempotency-key': 'expiry-request-1'
					},
					body: JSON.stringify(metadata)
				})
			);
			const share = await created.json();
			await expiryApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/audio`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'audio/mpeg'
					},
					body: new Uint8Array([1, 2, 3, 4])
				})
			);

			await processingComplete;
			await new Promise<void>((resolve) => setImmediate(resolve));
			let detail: Record<string, unknown> = {};
			for (let attempt = 0; attempt < 5; attempt++) {
				const response = await expiryApi.fetch(
					new Request(`http://share.test/api/shares/${share.id}`, {
						headers: { authorization: 'Bearer local-test-token' }
					})
				);
				detail = await response.json();
				if (detail.status === 'ready') break;
				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			expect(detail?.expiresAt).toBe('2026-11-17T00:00:00.000Z');
			const token = new URL(String(detail?.url)).pathname.split('/').at(-1);
			const preview = await expiryApi.fetch(
				new Request(`http://share.test/api/public/${token}`)
			);
			expect(preview.status).toBe(200);
			expect((await preview.json()).expiresAt).toBe('2026-11-17T00:00:00.000Z');

			currentTime = new Date('2026-11-16T23:00:00.000Z');
			const opened = await expiryApi.fetch(
				new Request(`http://share.test/api/public/${token}/open`, { method: 'POST' })
			);
			expect(opened.status).toBe(204);

			const extended = await expiryApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}`, {
					headers: { authorization: 'Bearer local-test-token' }
				})
			);
			expect((await extended.json()).expiresAt).toBe('2026-11-17T23:00:00.000Z');

			currentTime = new Date('2026-11-17T23:00:00.000Z');
			const lateOpen = await expiryApi.fetch(
				new Request(`http://share.test/api/public/${token}/open`, { method: 'POST' })
			);
			expect(lateOpen.status).toBe(410);
			const expiredPage = await expiryApi.fetch(
				new Request(`http://share.test/api/public/${token}`)
			);
			expect(expiredPage.status).toBe(410);
			const expiredDetail = await expiryApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}`, {
					headers: { authorization: 'Bearer local-test-token' }
				})
			);
			expect((await expiredDetail.json()).status).toBe('expired');
		} finally {
			await expiryApi.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('removes expired audio during the scheduled sweep', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'oh-mygo-share-sweep-'));
		let currentTime = new Date('2026-11-16T00:00:00.000Z');
		let resolveProcessing!: () => void;
		const processingComplete = new Promise<void>((resolve) => {
			resolveProcessing = resolve;
		});
		const mediaDirectory = join(directory, 'media');
		const sweepApi = createShareApi({
			databasePath: join(directory, 'shares.sqlite'),
			mediaDirectory,
			adminToken: 'local-test-token',
			publicOrigin: 'https://share.example',
			now: () => new Date(currentTime),
			mediaProcessor: async (sourcePath: string, outputPath: string) => {
				await copyFile(sourcePath, outputPath);
				resolveProcessing();
				return { mimeType: 'audio/mpeg', durationMs: 180_000 };
			}
		});

		try {
			const created = await sweepApi.fetch(
				new Request('http://share.test/api/shares', {
					method: 'POST',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'application/json',
						'idempotency-key': 'sweep-request-1'
					},
					body: JSON.stringify(metadata)
				})
			);
			const share = await created.json();
			await sweepApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}/audio`, {
					method: 'PUT',
					headers: {
						authorization: 'Bearer local-test-token',
						'content-type': 'audio/mpeg'
					},
					body: new Uint8Array([1, 2, 3, 4])
				})
			);
			await processingComplete;
			for (let attempt = 0; attempt < 10; attempt++) {
				const detail = await sweepApi.fetch(
					new Request(`http://share.test/api/shares/${share.id}`, {
						headers: { authorization: 'Bearer local-test-token' }
					})
				);
				if ((await detail.json()).status === 'ready') break;
				await new Promise<void>((resolve) => setTimeout(resolve, 2));
			}
			expect((await readdir(mediaDirectory)).some((name) => name.endsWith('.mp3'))).toBe(true);

			currentTime = new Date('2026-11-17T00:00:00.000Z');
			await sweepApi.sweep();

			const detail = await sweepApi.fetch(
				new Request(`http://share.test/api/shares/${share.id}`, {
					headers: { authorization: 'Bearer local-test-token' }
				})
			);
			expect((await detail.json()).status).toBe('expired');
			expect(await readdir(mediaDirectory)).toEqual([]);
		} finally {
			await sweepApi.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
