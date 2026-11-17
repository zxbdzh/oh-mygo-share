import { resolve } from 'node:path';
import { createShareApi } from './share-api';

type ShareApi = ReturnType<typeof createShareApi>;

let api: ShareApi | undefined;
let sweepTimer: NodeJS.Timeout | undefined;

export function getShareApi(): ShareApi {
	if (api) return api;

	const adminToken = process.env.SHARE_ADMIN_TOKEN ?? '';
	if (process.env.NODE_ENV === 'production' && Buffer.byteLength(adminToken, 'utf8') < 32) {
		throw new Error('Set SHARE_ADMIN_TOKEN to a random value of at least 32 bytes');
	}
	if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_ORIGIN) {
		throw new Error('Set PUBLIC_ORIGIN to the public HTTPS origin');
	}

	const dataDirectory = resolve(process.env.SHARE_DATA_DIRECTORY ?? './data');
	api = createShareApi({
		databasePath: resolve(process.env.SHARE_DATABASE_PATH ?? `${dataDirectory}/shares.sqlite`),
		mediaDirectory: resolve(process.env.SHARE_MEDIA_DIRECTORY ?? `${dataDirectory}/media`),
		adminToken,
		maxUploadBytes: positiveInteger('SHARE_MAX_UPLOAD_BYTES', 512 * 1024 * 1024),
		maxStorageBytes: positiveInteger('SHARE_MAX_STORAGE_BYTES', 10 * 1024 * 1024 * 1024),
		maxConcurrentJobs: positiveInteger('SHARE_MAX_CONCURRENT_JOBS', 2),
		maxAudioDurationMs: positiveInteger('SHARE_MAX_DURATION_MS', 24 * 60 * 60 * 1000),
		publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000'
	});
	sweepTimer ??= setInterval(() => {
		void api?.sweep().catch((error: unknown) => console.error('Share cleanup failed', error));
	}, 60_000);
	sweepTimer.unref();
	return api;
}

function positiveInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	return value;
}
