import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { constants, createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { processMediaFile } from './media-processor';
import type { ShareHotComment, ShareLyricWord } from '../types';

const templates = new Set(['minimal', 'cinema', 'vinyl', 'polaroid', 'ticket']);
const maxMetadataBytes = 1024 * 1024;
const maxLyrics = 5000;
const maxDurationMs = 24 * 60 * 60 * 1000;
const defaultMaxUploadBytes = 512 * 1024 * 1024;
const maxCoverBytes = 10 * 1024 * 1024;
const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const acceptedMediaTypes = new Set([
	'audio/aac',
	'audio/flac',
	'audio/mp4',
	'audio/mpeg',
	'audio/ogg',
	'audio/wav',
	'audio/x-wav'
]);

export type ShareMetadata = {
	title: string;
	artists: string;
	sourceId: string;
	accountId?: string;
	trackId: string;
	playbackId?: string;
	quality: 'standard' | 'high' | 'lossless';
	template: 'minimal' | 'cinema' | 'vinyl' | 'polaroid' | 'ticket';
	cardSquare: boolean;
	mode: 'full' | 'clip';
	durationMs: number;
	lyrics: Array<{
		text: string;
		translation?: string;
		atMs: number;
		endMs: number;
		words?: ShareLyricWord[];
		stageEndMs?: number;
	}>;
	selectedLineIndexes: number[];
	hotComments?: ShareHotComment[];
	clipStartMs?: number;
	clipEndMs?: number;
	sourceUrl?: string;
	coverHash?: string;
};

export type ShareApiOptions = {
	databasePath: string;
	mediaDirectory: string;
	adminToken: string;
	publicOrigin?: string;
	maxUploadBytes?: number;
	maxStorageBytes?: number;
	maxConcurrentJobs?: number;
	maxAudioDurationMs?: number;
	mediaProcessor?: MediaProcessor;
	now?: () => Date;
};

export type ProcessedMedia = { mimeType: string; durationMs: number };
export type MediaProcessor = (
	inputPath: string,
	outputPath: string,
	metadata: ShareMetadata,
	inputMimeType: string
) => Promise<ProcessedMedia>;

export function createShareApi(options: ShareApiOptions) {
	mkdirSync(dirname(options.databasePath), { recursive: true });
	mkdirSync(options.mediaDirectory, { recursive: true });

	const db = new Database(options.databasePath);
	db.pragma('journal_mode = WAL');
	db.pragma('busy_timeout = 5000');
	db.pragma('foreign_keys = ON');
	db.exec(`
		CREATE TABLE IF NOT EXISTS shares (
			id TEXT PRIMARY KEY,
			public_token TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL,
			metadata_json TEXT NOT NULL,
			idempotency_key TEXT NOT NULL UNIQUE,
			request_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			expires_at TEXT,
			last_opened_at TEXT,
			revoked_at TEXT,
			media_path TEXT,
			mime_type TEXT,
			input_mime_type TEXT,
			duration_ms INTEGER,
			error_code TEXT,
			cover_path TEXT,
			cover_mime_type TEXT,
			cover_hash TEXT
		)
	`);
	for (const statement of [
		'ALTER TABLE shares ADD COLUMN input_mime_type TEXT',
		'ALTER TABLE shares ADD COLUMN error_code TEXT',
		'ALTER TABLE shares ADD COLUMN cover_path TEXT',
		'ALTER TABLE shares ADD COLUMN cover_mime_type TEXT',
		'ALTER TABLE shares ADD COLUMN cover_hash TEXT'
	]) {
		try {
			db.exec(statement);
		} catch (error) {
			if (!isDuplicateColumnError(error)) throw error;
		}
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS listen_sessions (
			id TEXT PRIMARY KEY,
			share_id TEXT NOT NULL REFERENCES shares(id),
			started_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			closed_at TEXT
		)
	`);
	try {
		db.exec('ALTER TABLE listen_sessions ADD COLUMN paused_at TEXT');
	} catch (error) {
		if (!isDuplicateColumnError(error)) throw error;
	}

	const findById = db.prepare<{ id: string }>('SELECT * FROM shares WHERE id = @id');
	db.exec('CREATE INDEX IF NOT EXISTS shares_reuse ON shares(request_hash, status, expires_at)');
	const findReusableShare = db.prepare<[string, string]>(`
		SELECT * FROM shares
		WHERE request_hash = ? AND status = 'ready' AND expires_at > ?
		ORDER BY expires_at DESC, id DESC LIMIT 1
	`);
	const findByPublicToken = db.prepare<{ token: string }>(
		'SELECT * FROM shares WHERE public_token = @token'
	);
	const listShares = db.prepare<[number]>(
		'SELECT * FROM shares ORDER BY updated_at DESC, id DESC LIMIT ?'
	);
	const findByIdempotencyKey = db.prepare<[{ key: string }]>(
		'SELECT id, status, metadata_json, request_hash FROM shares WHERE idempotency_key = @key'
	);
	const insertShare = db.prepare<{
		id: string;
		publicToken: string;
		metadata: string;
		idempotencyKey: string;
		requestHash: string;
		createdAt: string;
	}>(`
		INSERT INTO shares (
			id, public_token, status, metadata_json, idempotency_key, request_hash, created_at, updated_at
		) VALUES (
			@id, @publicToken, 'awaiting_upload', @metadata, @idempotencyKey, @requestHash, @createdAt, @createdAt
		)
	`);
	const reserveUpload = db.prepare<[string, string, string]>(
		"UPDATE shares SET status = 'uploading', input_mime_type = ?, error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('awaiting_upload', 'failed')"
	);
	const setProcessing = db.prepare<[string, string]>(
		"UPDATE shares SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'uploading'"
	);
	const setReady = db.prepare<[string, string, number, string, string, string]>(`
		UPDATE shares
		SET status = 'ready', media_path = ?, mime_type = ?, input_mime_type = NULL, duration_ms = ?, expires_at = ?, updated_at = ?, error_code = NULL
		WHERE id = ? AND status = 'processing'
	`);
	const markFailed = db.prepare<[string, string, string]>(`
		UPDATE shares SET status = 'failed', input_mime_type = NULL, error_code = ?, updated_at = ?
		WHERE id = ? AND status = 'processing'
	`);
	const findInterruptedJobs = db.prepare(
		"SELECT id, status, input_mime_type, metadata_json FROM shares WHERE status IN ('uploading', 'processing')"
	);
	const resetInterruptedUpload = db.prepare<[string, string]>(`
		UPDATE shares SET status = 'awaiting_upload', input_mime_type = NULL, error_code = NULL, updated_at = ?
		WHERE id = ? AND status = 'uploading'
	`);
	const setCover = db.prepare<[string, string, string, string, string]>(`
		UPDATE shares SET cover_path = ?, cover_mime_type = ?, cover_hash = ?, updated_at = ?
		WHERE id = ? AND status IN ('awaiting_upload', 'failed') AND cover_path IS NULL
	`);
	const revokeShare = db.prepare<[string, string, string]>(`
		UPDATE shares SET status = 'revoked', revoked_at = ?, updated_at = ?
		WHERE id = ? AND status IN ('awaiting_upload', 'uploading', 'processing', 'ready', 'failed')
	`);
	const touchShare = db.prepare<[string, string, string, string, string]>(`
		UPDATE shares SET last_opened_at = ?, expires_at = ?, updated_at = ?
		WHERE public_token = ? AND status = 'ready' AND expires_at > ?
	`);
	const expireShare = db.prepare<[string, string]>(`
		UPDATE shares SET status = 'expired', updated_at = ?
		WHERE id = ? AND status = 'ready'
	`);
	const createListenSession = db.prepare<[string, string, string, string]>(`
		INSERT INTO listen_sessions (id, share_id, started_at, last_active_at) VALUES (?, ?, ?, ?)
	`);
	const findListenSession = db.prepare<[string, string]>(`
		SELECT listen_sessions.id, listen_sessions.last_active_at, listen_sessions.paused_at, listen_sessions.closed_at, shares.id AS share_id
		FROM listen_sessions
		JOIN shares ON shares.id = listen_sessions.share_id
		WHERE shares.public_token = ? AND listen_sessions.id = ?
	`);
	const touchListenSession = db.prepare<[string, string]>(
		'UPDATE listen_sessions SET last_active_at = ?, paused_at = NULL WHERE id = ? AND closed_at IS NULL'
	);
	const pauseListenSession = db.prepare<[string, string, string]>(
		'UPDATE listen_sessions SET last_active_at = ?, paused_at = ? WHERE id = ? AND closed_at IS NULL AND paused_at IS NULL'
	);
	const closeListenSession = db.prepare<[string, string]>(
		'UPDATE listen_sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL'
	);
	const closeIdleListenSessions = db.prepare<[string, string]>(`
		UPDATE listen_sessions SET closed_at = ?
		WHERE closed_at IS NULL AND last_active_at <= ?
	`);
	const findTerminalShares = db.prepare(
		"SELECT id, media_path, cover_path FROM shares WHERE status IN ('revoked', 'expired') AND (media_path IS NOT NULL OR cover_path IS NOT NULL)"
	);
	const activeSessionExists = db.prepare<[string, string]>(`
		SELECT 1 FROM listen_sessions
		WHERE share_id = ? AND closed_at IS NULL AND last_active_at > ?
		LIMIT 1
	`);
	const clearShareFiles = db.prepare<[string, string]>(`
		UPDATE shares SET media_path = NULL, cover_path = NULL, updated_at = ?
		WHERE id = ? AND status IN ('revoked', 'expired')
	`);

	const now = options.now ?? (() => new Date());
	const maxUploadBytes = options.maxUploadBytes ?? defaultMaxUploadBytes;
	const maxStorageBytes = options.maxStorageBytes ?? 10 * 1024 * 1024 * 1024;
	const maxConcurrentJobs = options.maxConcurrentJobs ?? 2;
	let admittedUploads = 0;
	let reservedStorage = 0;
	let admissionLock = Promise.resolve();
	let runningProcessors = 0;
	const processorWaiters: Array<() => void> = [];
	const mediaProcessor = options.mediaProcessor ?? processMediaFile;
	const publicOrigin = parsePublicOrigin(options.publicOrigin ?? 'http://localhost:3000');
	const processingJobs = new Set<Promise<void>>();
	const recoveryTask = recoverInterruptedJobs();

	return {
		async fetch(request: Request): Promise<Response> {
			await recoveryTask;
			const url = new URL(request.url);
			const parts = url.pathname.split('/').filter(Boolean);
			if (url.pathname === '/healthz' && request.method === 'GET') {
				return json({ status: 'ok' }, 200);
			}
			if (parts[0] === 'api' && parts[1] === 'shares') {
				if (!authorized(request, options.adminToken)) return json({ error: 'unauthorized' }, 401);
				if (parts.length === 3 && parts[2] === 'reuse' && request.method === 'POST') return reuseShare(request);
				if (parts.length === 2 && request.method === 'POST') return createShare(request);
				if (parts.length === 2 && request.method === 'GET') return getShares(url);
				if (parts.length === 3 && request.method === 'GET') return getShare(parts[2]);
				if (parts.length === 3 && request.method === 'DELETE') return deleteShare(parts[2]);
				if (parts.length === 4 && parts[3] === 'audio' && request.method === 'PUT') {
					return uploadAudio(request, parts[2]);
				}
				if (parts.length === 4 && parts[3] === 'cover' && request.method === 'PUT') {
					return uploadCover(request, parts[2]);
				}
				return json({ error: 'not_found' }, 404);
			}

			if (parts[0] === 'api' && parts[1] === 'public' && parts.length === 3) {
				if (request.method === 'GET') return getPublicShare(parts[2]);
			}
			if (parts[0] === 'api' && parts[1] === 'public' && parts.length === 4) {
				if (parts[3] === 'open' && request.method === 'POST') return openPublicShare(parts[2]);
				if (parts[3] === 'sessions' && request.method === 'POST') return createListenSessionFor(parts[2]);
				if (parts[3] === 'audio' && request.method === 'GET') {
					return streamPublicAudio(request, parts[2], url);
				}
				if (parts[3] === 'cover' && request.method === 'GET') {
					return streamPublicCover(parts[2]);
				}
			}
			if (
				parts[0] === 'api' &&
				parts[1] === 'public' &&
				parts.length === 6 &&
				parts[3] === 'sessions' &&
				parts[5] === 'activity' &&
				request.method === 'POST'
			) {
				return updateListenActivity(request, parts[2], parts[4]);
			}
			if (
				parts[0] === 'api' &&
				parts[1] === 'public' &&
				parts.length === 6 &&
				parts[3] === 'sessions' &&
				parts[5] === 'close' &&
				request.method === 'POST'
			) {
				return endListenSession(parts[2], parts[4]);
			}
			return json({ error: 'not_found' }, 404);
		},
		async close() {
			await recoveryTask;
			while (processingJobs.size > 0) {
				await Promise.allSettled([...processingJobs]);
			}
			await cleanupTerminalMedia();
			db.close();
		},
		async sweep() {
			await recoveryTask;
			return cleanupTerminalMedia();
		}
	};

	async function reuseShare(request: Request): Promise<Response> {
		let raw: unknown;
		try {
			raw = await readJson(request);
		} catch (error) {
			return json(
				{ error: error instanceof RangeError ? 'metadata_too_large' : 'invalid_json' },
				error instanceof RangeError ? 413 : 400
			);
		}
		const parsed = parseMetadata(raw);
		if (!parsed.ok) return json({ error: 'invalid_metadata', field: parsed.field }, 400);
		const hash = createHash('sha256').update(JSON.stringify(parsed.value)).digest('hex');
		// 复用只查询完整快照，不算一次听歌访问，也不延长原分享有效期。
		const row = findReusableShare.get(hash, now().toISOString()) as ShareRow | undefined;
		return row ? json(shareDetails(row, publicOrigin), 200) : new Response(null, { status: 204 });
	}

	async function createShare(request: Request): Promise<Response> {
			const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
			if (!/^[\w-]{8,128}$/.test(idempotencyKey)) {
				return json({ error: 'invalid_idempotency_key' }, 400);
			}

			let raw: unknown;
			try {
				raw = await readJson(request);
			} catch (error) {
				return json(
					{ error: error instanceof RangeError ? 'metadata_too_large' : 'invalid_json' },
					error instanceof RangeError ? 413 : 400
				);
			}

			const parsed = parseMetadata(raw);
			if (!parsed.ok) return json({ error: 'invalid_metadata', field: parsed.field }, 400);

			const metadata = JSON.stringify(parsed.value);
			const requestHash = createHash('sha256').update(metadata).digest('hex');
			const createdAt = now().toISOString();
			const outcome = db.transaction(() => {
				const existing = findByIdempotencyKey.get({ key: idempotencyKey }) as
					| { id: string; status: string; metadata_json: string; request_hash: string }
					| undefined;
				if (existing) {
					return existing.request_hash === requestHash
						? { kind: 'existing' as const, row: existing }
						: { kind: 'conflict' as const };
				}

				const id = randomUUID();
				insertShare.run({
					id,
					publicToken: randomBytes(32).toString('base64url'),
					metadata,
					idempotencyKey,
					requestHash,
					createdAt
				});
				return json(
					{ id, status: 'awaiting_upload', metadata: parsed.value },
					201,
					{ location: `/api/shares/${id}` }
				);
			}).immediate();

			if (outcome instanceof Response) return outcome;
			if (outcome.kind === 'conflict') return json({ error: 'idempotency_conflict' }, 409);
			if (outcome.row.status === 'ready') {
				const readyShare = findById.get({ id: outcome.row.id }) as ShareRow | undefined;
				if (readyShare) return json(shareDetails(readyShare, publicOrigin), 200);
			}
			return json(
				{
					id: outcome.row.id,
					status: outcome.row.status,
					metadata: JSON.parse(outcome.row.metadata_json)
				},
				200
			);
	}

	function getShare(id: string): Response {
		const row = findById.get({ id }) as ShareRow | undefined;
		if (row?.status === 'ready' && (!row.expires_at || Date.parse(row.expires_at) <= now().getTime())) {
			expireShare.run(now().toISOString(), id);
			row.status = 'expired';
			scheduleCleanup();
		}
		return row ? json(shareDetails(row, publicOrigin), 200) : json({ error: 'not_found' }, 404);
	}

	function getShares(url: URL): Response {
		const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
		if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
			return json({ error: 'invalid_limit' }, 400);
		}
		const timestamp = now().toISOString();
		db.prepare(`
			UPDATE shares SET status = 'expired', updated_at = ?
			WHERE status = 'ready' AND expires_at <= ?
		`).run(timestamp, timestamp);
		scheduleCleanup();

		const rows = listShares.all(requestedLimit) as ShareRow[];
		return json(
			{
				shares: rows.map((row) => {
					const metadata = JSON.parse(row.metadata_json) as ShareMetadata;
					return {
						id: row.id,
						status: row.status,
						title: metadata.title,
						artists: metadata.artists,
						mode: metadata.mode,
						template: metadata.template,
						cardSquare: metadata.cardSquare,
						createdAt: row.created_at,
						...(row.status === 'ready' ? { url: `${publicOrigin}/s/${row.public_token}` } : {}),
						...(row.expires_at ? { expiresAt: row.expires_at } : {}),
						...(row.last_opened_at ? { lastOpenedAt: row.last_opened_at } : {}),
						...(row.error_code ? { error: row.error_code } : {})
					};
				})
			},
			200
		);
	}

	function deleteShare(id: string): Response {
		const timestamp = now().toISOString();
		if (revokeShare.run(timestamp, timestamp, id).changes === 1) {
			scheduleCleanup();
			return new Response(null, { status: 204 });
		}

		const row = findById.get({ id }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		return json({ error: row.status === 'revoked' ? 'already_revoked' : 'cannot_revoke' }, 409);
	}

	async function uploadAudio(request: Request, id: string): Promise<Response> {
		const row = findById.get({ id }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		if (row.status !== 'awaiting_upload' && row.status !== 'failed') {
			return json({ error: 'upload_not_allowed' }, 409);
		}

		const mimeType = normalizeMediaType(request.headers.get('content-type'));
		if (!mimeType || !acceptedMediaTypes.has(mimeType)) {
			return json({ error: 'unsupported_media_type' }, 415);
		}
		const contentLength = Number(request.headers.get('content-length') ?? 0);
		if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
			return json({ error: 'upload_too_large' }, 413);
		}
		if (!request.body) return json({ error: 'missing_audio' }, 400);
		let reservation = 0;
		const previousAdmission = admissionLock;
		let unlockAdmission!: () => void;
		admissionLock = new Promise<void>((resolve) => { unlockAdmission = resolve; });
		await previousAdmission;
		try {
			if (admittedUploads >= maxConcurrentJobs) return json({ error: 'processing_busy' }, 429, { 'retry-after': '5' });
			// 同时预留输入和输出空间；拒绝新任务，不清除仍有效的分享。
			reservation = 2 * (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : maxUploadBytes);
			if (await mediaStorageBytes() + reservedStorage + reservation > maxStorageBytes) {
				return json({ error: 'storage_limit_exceeded' }, 507);
			}
			admittedUploads++;
			reservedStorage += reservation;
		} finally { unlockAdmission(); }
		const releaseReservation = () => { admittedUploads--; reservedStorage -= reservation; };

		if (reserveUpload.run(mimeType, now().toISOString(), id).changes !== 1) {
			releaseReservation();
			return json({ error: 'upload_not_allowed' }, 409);
		}

		const inputPath = join(options.mediaDirectory, `.${id}.upload`);
		try {
			const uploadedBytes = await writeBoundedUpload(request.body, inputPath, Math.min(maxUploadBytes, reservation / 2));
			if (uploadedBytes === 0) throw new Error('empty_audio');
			setProcessing.run(now().toISOString(), id);
			trackProcessing(processUpload(id, inputPath, mimeType, JSON.parse(row.metadata_json) as ShareMetadata).finally(releaseReservation));
			return json({ id, status: 'processing' }, 202);
		} catch (error) {
			releaseReservation();
			await rm(inputPath, { force: true }).catch(() => undefined);
			resetInterruptedUpload.run(now().toISOString(), id);
			if (error instanceof UploadTooLargeError) return json({ error: 'upload_too_large' }, 413);
			if (error instanceof Error && error.message === 'empty_audio') {
				return json({ error: 'empty_audio' }, 400);
			}
			return json({ error: 'upload_failed' }, 400);
		}
	}

	async function uploadCover(request: Request, id: string): Promise<Response> {
		const row = findById.get({ id }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		if (row.status !== 'awaiting_upload' && row.status !== 'failed') {
			return json({ error: 'cover_not_allowed' }, 409);
		}

		const mimeType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
		if (!mimeType || !acceptedImageTypes.has(mimeType)) {
			return json({ error: 'unsupported_media_type' }, 415);
		}
		const contentLength = Number(request.headers.get('content-length') ?? 0);
		if (Number.isFinite(contentLength) && contentLength > maxCoverBytes) {
			return json({ error: 'cover_too_large' }, 413);
		}
		if (!request.body) return json({ error: 'missing_cover' }, 400);
		const previousAdmission = admissionLock;
		let unlockAdmission!: () => void;
		admissionLock = new Promise<void>((resolve) => { unlockAdmission = resolve; });
		await previousAdmission;
		const coverReservation = 2 * (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : maxCoverBytes);
		try {
			if (await mediaStorageBytes() + reservedStorage + coverReservation > maxStorageBytes) return json({ error: 'storage_limit_exceeded' }, 507);
			reservedStorage += coverReservation;
		} finally { unlockAdmission(); }

		const temporaryPath = join(options.mediaDirectory, `.${id}.${randomUUID()}.cover-upload`);
		try {
			const bytesWritten = await writeBoundedUpload(request.body, temporaryPath, Math.min(maxCoverBytes, coverReservation / 2));
			const bytes = await readFile(temporaryPath);
			if (bytesWritten === 0 || !validImageSignature(mimeType, bytes)) {
				throw new Error('invalid_cover');
			}
			const hash = createHash('sha256').update(bytes).digest('hex');
			const current = findById.get({ id }) as ShareRow | undefined;
			if (!current || (current.status !== 'awaiting_upload' && current.status !== 'failed')) {
				return json({ error: 'cover_not_allowed' }, 409);
			}
			if (current.cover_hash) {
				return current.cover_hash === hash
					? json({ id, status: 'cover_uploaded' }, 200)
					: json({ error: 'cover_conflict' }, 409);
			}

			const coverPath = join(options.mediaDirectory, `${id}.cover-${hash}`);
			try {
				await copyFile(temporaryPath, coverPath, constants.COPYFILE_EXCL);
			} catch (error) {
				if (!(isNodeError(error) && error.code === 'EEXIST')) throw error;
			}
			if (setCover.run(coverPath, mimeType, hash, now().toISOString(), id).changes !== 1) {
				const winner = findById.get({ id }) as ShareRow | undefined;
				if (winner?.cover_hash === hash) {
					return json({ id, status: 'cover_uploaded' }, 200);
				}
				await rm(coverPath, { force: true });
				return json({ error: 'cover_not_allowed' }, 409);
			}
			return json({ id, status: 'cover_uploaded' }, 201);
		} catch (error) {
			if (error instanceof UploadTooLargeError) return json({ error: 'cover_too_large' }, 413);
			return json({ error: 'invalid_cover' }, 400);
		} finally {
			reservedStorage -= coverReservation;
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	async function processUpload(
		id: string,
		inputPath: string,
		mimeType: string,
		metadata: ShareMetadata
	): Promise<void> {
		// 重启恢复的持久任务也经过同一个并发门禁，避免一次拉起全部 FFmpeg。
		if (runningProcessors >= maxConcurrentJobs) await new Promise<void>((resolve) => processorWaiters.push(resolve));
		else runningProcessors++;
		const outputPath = join(options.mediaDirectory, `${id}${mediaExtension(mimeType)}`);
		try {
			const processed = await mediaProcessor(inputPath, outputPath, metadata, mimeType);
			const outputStat = await stat(outputPath);
			if (
				outputStat.size === 0 ||
				!acceptedMediaTypes.has(processed.mimeType) ||
				!Number.isSafeInteger(processed.durationMs) ||
				processed.durationMs <= 0 ||
				processed.durationMs > (options.maxAudioDurationMs ?? maxDurationMs) ||
				outputStat.size > maxUploadBytes
			) {
				throw new Error('invalid_processed_audio');
			}

			const timestamp = now();
			const expiresAt = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString();
			const updated = setReady.run(
				outputPath,
				processed.mimeType,
				processed.durationMs,
				expiresAt,
				timestamp.toISOString(),
				id
			).changes;
			if (updated === 0) {
				await rm(outputPath, { force: true });
				await cleanupTerminalMedia();
			}
		} catch {
			await rm(outputPath, { force: true }).catch(() => undefined);
			markFailed.run('media_processing_failed', now().toISOString(), id);
		} finally {
			await rm(inputPath, { force: true }).catch(() => undefined);
			const next = processorWaiters.shift();
			if (next) next();
			else runningProcessors--;
		}
	}

	async function mediaStorageBytes(): Promise<number> {
		let total = 0;
		for (const entry of await readdir(options.mediaDirectory, { withFileTypes: true })) {
			if (entry.isFile()) total += (await stat(join(options.mediaDirectory, entry.name)).catch(() => null))?.size ?? 0;
		}
		return total;
	}

	function getPublicShare(token: string): Response {
		const row = findByPublicToken.get({ token }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		const accessError = publicAccessError(row);
		if (accessError) return accessError;

		const metadata = JSON.parse(row.metadata_json) as ShareMetadata;
		const selected = new Set(metadata.selectedLineIndexes);
		const lyrics =
			metadata.mode === 'clip'
				? metadata.lyrics
						.map((line, index) => ({ line, index }))
						.filter(
							({ line }) =>
								(line.stageEndMs ?? line.endMs) > (metadata.clipStartMs ?? 0) && line.atMs < (metadata.clipEndMs ?? 0)
						)
						.map(({ line, index }) => ({
							text: line.text,
							...(line.translation ? { translation: line.translation } : {}),
							atMs: Math.max(0, line.atMs - (metadata.clipStartMs ?? 0)),
							endMs: Math.min(metadata.clipEndMs ?? line.endMs, line.endMs) - (metadata.clipStartMs ?? 0),
							...(line.stageEndMs !== undefined ? { stageEndMs: Math.min(metadata.clipEndMs!, line.stageEndMs) - metadata.clipStartMs! } : {}),
							...(line.words ? {
								words: line.words
									.filter((word) => word.endMs > metadata.clipStartMs! && word.startMs < metadata.clipEndMs!)
									.map((word) => ({
										text: word.text,
										startMs: Math.max(word.startMs, metadata.clipStartMs!) - metadata.clipStartMs!,
										endMs: Math.min(word.endMs, metadata.clipEndMs!) - metadata.clipStartMs!
									}))
							} : {}),
							selected: selected.has(index)
						}))
				: metadata.lyrics.map((line, index) => ({
						...line,
						selected: selected.has(index)
					}));

		return json({
			token,
			title: metadata.title,
			artists: metadata.artists,
			template: metadata.template,
			cardSquare: metadata.cardSquare,
			mode: metadata.mode,
			durationMs: row.duration_ms,
			lyrics,
			...(metadata.hotComments?.length ? { hotComments: metadata.hotComments } : {}),
			...(row.cover_path ? { coverUrl: `/api/public/${token}/cover` } : {}),
			...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
			audioUrl: `/api/public/${token}/audio`,
			expiresAt: row.expires_at,
			available: true
		}, 200);
	}

	function openPublicShare(token: string): Response {
		const row = findByPublicToken.get({ token }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		const accessError = publicAccessError(row);
		if (accessError) return accessError;

		const timestamp = now();
		const at = timestamp.toISOString();
		const expiresAt = new Date(timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString();
		const changed = touchShare.run(at, expiresAt, at, token, at).changes;
		return changed === 1
			? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
			: json({ error: 'expired' }, 410);
	}

	function createListenSessionFor(token: string): Response {
		const row = findByPublicToken.get({ token }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		const accessError = publicAccessError(row);
		if (accessError) return accessError;

		const sessionId = randomBytes(24).toString('base64url');
		const timestamp = now().toISOString();
		createListenSession.run(sessionId, row.id, timestamp, timestamp);
		return json(
			{
				sessionId,
				audioUrl: `/api/public/${token}/audio?session=${sessionId}`
			},
			201
		);
	}

	async function updateListenActivity(request: Request, token: string, sessionId: string): Promise<Response> {
		const session = validListenSession(token, sessionId);
		if (!session) return json({ error: 'session_expired' }, 410);
		let state: unknown;
		try {
			state = await readJson(request);
		} catch {
			return json({ error: 'invalid_json' }, 400);
		}
		if (!isRecord(state) || typeof state.playing !== 'boolean') {
			return json({ error: 'invalid_activity' }, 400);
		}

		const timestamp = now().toISOString();
		// 重复暂停消息不能把连续暂停的十五分钟重新计时。
		if (state.playing) touchListenSession.run(timestamp, sessionId);
		else pauseListenSession.run(timestamp, timestamp, sessionId);
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}

	function endListenSession(token: string, sessionId: string): Response {
		const session = validListenSession(token, sessionId);
		if (!session) return json({ error: 'session_expired' }, 410);
		closeListenSession.run(now().toISOString(), sessionId);
		scheduleCleanup();
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}

	async function streamPublicAudio(request: Request, token: string, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session');
		if (!sessionId) return json({ error: 'session_required' }, 401);
		const session = validListenSession(token, sessionId);
		if (!session) return json({ error: 'session_expired' }, 410);

		const row = findByPublicToken.get({ token }) as ShareRow | undefined;
		if (!row?.media_path || !row.mime_type) return json({ error: 'media_unavailable' }, 404);
		let mediaStat;
		try {
			mediaStat = await stat(row.media_path);
		} catch {
			return json({ error: 'media_unavailable' }, 404);
		}
		if (!mediaStat.isFile() || mediaStat.size <= 0) return json({ error: 'media_unavailable' }, 404);

		const range = parseRange(request.headers.get('range'), mediaStat.size);
		if (range === 'invalid') {
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${mediaStat.size}`, 'cache-control': 'no-store' }
			});
		}

		const start = range?.start ?? 0;
		const end = range?.end ?? mediaStat.size - 1;
		const stream = createReadStream(row.media_path, { start, end });
		const headers = new Headers({
			'accept-ranges': 'bytes',
			'cache-control': 'no-store',
			'content-type': row.mime_type,
			'content-length': String(end - start + 1),
			'etag': `"${row.id}-${mediaStat.size}"`
		});
		if (range) headers.set('content-range', `bytes ${start}-${end}/${mediaStat.size}`);
		return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
			status: range ? 206 : 200,
			headers
		});
	}

	async function streamPublicCover(token: string): Promise<Response> {
		const row = findByPublicToken.get({ token }) as ShareRow | undefined;
		if (!row) return json({ error: 'not_found' }, 404);
		const accessError = publicAccessError(row);
		if (accessError) return accessError;
		if (!row.cover_path || !row.cover_mime_type) return json({ error: 'cover_unavailable' }, 404);

		try {
			const coverStat = await stat(row.cover_path);
			const stream = createReadStream(row.cover_path);
			return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
				status: 200,
				headers: {
					'cache-control': 'no-store',
					'content-length': String(coverStat.size),
					'content-security-policy': "default-src 'none'",
					'content-type': row.cover_mime_type,
					'x-content-type-options': 'nosniff'
				}
			});
		} catch {
			return json({ error: 'cover_unavailable' }, 404);
		}
	}

	function validListenSession(token: string, sessionId: string) {
		const session = findListenSession.get(token, sessionId) as
			| { id: string; last_active_at: string; closed_at: string | null; share_id: string }
			| undefined;
		if (!session || session.closed_at) return null;

		const cutoff = now().getTime() - 15 * 60 * 1000;
		if (Date.parse(session.last_active_at) <= cutoff) {
			closeListenSession.run(now().toISOString(), sessionId);
			scheduleCleanup();
			return null;
		}

		const share = findById.get({ id: session.share_id }) as ShareRow | undefined;
		if (!share || (share.status !== 'ready' && share.status !== 'revoked' && share.status !== 'expired')) {
			return null;
		}
		if (share.status === 'ready' && share.expires_at && Date.parse(share.expires_at) <= now().getTime()) {
			expireShare.run(now().toISOString(), share.id);
			scheduleCleanup();
		}
		return session;
	}

	function trackProcessing(job: Promise<void>): void {
		processingJobs.add(job);
		void job.then(
			() => processingJobs.delete(job),
			() => processingJobs.delete(job)
		);
	}

	function scheduleCleanup(): void {
		trackProcessing(cleanupTerminalMedia().then(() => undefined));
	}

	async function recoverInterruptedJobs(): Promise<void> {
		const timestamp = now().toISOString();
		const rows = findInterruptedJobs.all() as Array<{
			id: string;
			status: string;
			input_mime_type: string | null;
			metadata_json: string;
		}>;

		for (const row of rows) {
			const inputPath = join(options.mediaDirectory, `.${row.id}.upload`);
			if (row.status === 'uploading') {
				await rm(inputPath, { force: true }).catch(() => undefined);
				resetInterruptedUpload.run(timestamp, row.id);
				continue;
			}

			if (!row.input_mime_type || !acceptedMediaTypes.has(row.input_mime_type)) {
				markFailed.run('processing_interrupted', timestamp, row.id);
				continue;
			}

			try {
				const inputStat = await stat(inputPath);
				if (!inputStat.isFile() || inputStat.size === 0) throw new Error('upload_missing');
				trackProcessing(
					processUpload(
						row.id,
						inputPath,
						row.input_mime_type,
						JSON.parse(row.metadata_json) as ShareMetadata
					)
				);
			} catch {
				await rm(inputPath, { force: true }).catch(() => undefined);
				markFailed.run('processing_interrupted', now().toISOString(), row.id);
			}
		}
	}

	async function cleanupTerminalMedia(): Promise<number> {
		const timestamp = now();
		const timestampText = timestamp.toISOString();
		const cutoffText = new Date(timestamp.getTime() - 15 * 60 * 1000).toISOString();
		db.prepare(`
			UPDATE shares SET status = 'expired', updated_at = ?
			WHERE status = 'ready' AND expires_at <= ?
		`).run(timestampText, timestampText);
		closeIdleListenSessions.run(timestampText, cutoffText);

		const rows = findTerminalShares.all() as Array<{
			id: string;
			media_path: string | null;
			cover_path: string | null;
		}>;
		let cleaned = 0;
		for (const row of rows) {
			if (activeSessionExists.get(row.id, cutoffText)) continue;
			const removed = await Promise.all([
				row.media_path ? rm(row.media_path, { force: true }).then(() => true, () => false) : true,
				row.cover_path ? rm(row.cover_path, { force: true }).then(() => true, () => false) : true
			]);
			if (!removed.every(Boolean)) continue;
			clearShareFiles.run(timestampText, row.id);
			cleaned++;
		}
		return cleaned;
	}

	function publicAccessError(row: ShareRow): Response | null {
		if (row.status === 'revoked') return json({ error: 'revoked' }, 410);
		if (row.status === 'expired') return json({ error: 'expired' }, 410);
		if (row.status !== 'ready') return json({ error: 'not_found' }, 404);
		if (!row.expires_at || Date.parse(row.expires_at) <= now().getTime()) {
			expireShare.run(now().toISOString(), row.id);
			scheduleCleanup();
			return json({ error: 'expired' }, 410);
		}
		return null;
	}
}

type ShareRow = {
	id: string;
	public_token: string;
	status: string;
	metadata_json: string;
	idempotency_key: string;
	request_hash: string;
	created_at: string;
	updated_at: string;
	expires_at: string | null;
	last_opened_at: string | null;
	revoked_at: string | null;
	media_path: string | null;
	mime_type: string | null;
	duration_ms: number | null;
	error_code: string | null;
	cover_path: string | null;
	cover_mime_type: string | null;
	cover_hash: string | null;
};

class UploadTooLargeError extends Error {}

type ByteRange = { start: number; end: number };

function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
	if (header === null) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (!match[1] && !match[2])) return 'invalid';

	if (!match[1]) {
		const suffixLength = Number(match[2]);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}

	const start = Number(match[1]);
	const requestedEnd = match[2] ? Number(match[2]) : size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 0 ||
		start >= size ||
		requestedEnd < start
	) {
		return 'invalid';
	}
	return { start, end: Math.min(requestedEnd, size - 1) };
}

async function writeBoundedUpload(
	body: ReadableStream<Uint8Array>,
	destination: string,
	maxBytes: number
): Promise<number> {
	let total = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.byteLength;
			if (total > maxBytes) callback(new UploadTooLargeError());
			else callback(null, chunk);
		}
	});
	await pipeline(
		Readable.from(body as unknown as AsyncIterable<Uint8Array>),
		limiter,
		createWriteStream(destination, { flags: 'wx', mode: 0o600 })
	);
	return total;
}

function shareDetails(row: ShareRow, publicOrigin: string): Record<string, unknown> {
	return {
		id: row.id,
		status: row.status,
		metadata: JSON.parse(row.metadata_json),
		...(row.status === 'ready' ? { url: `${publicOrigin}/s/${row.public_token}` } : {}),
		...(row.expires_at ? { expiresAt: row.expires_at } : {}),
		...(row.last_opened_at ? { lastOpenedAt: row.last_opened_at } : {}),
		...(row.error_code ? { error: row.error_code } : {})
	};
}

function parsePublicOrigin(value: string): string {
	const parsed = new URL(value);
	if (
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		parsed.username.length > 0 ||
		parsed.pathname !== '/' ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin');
	}
	return parsed.origin;
}

function normalizeMediaType(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.split(';', 1)[0].trim().toLowerCase();
	return acceptedMediaTypes.has(normalized) ? normalized : null;
}

function mediaExtension(mimeType: string): string {
	const extensions: Record<string, string> = {
		'audio/aac': '.aac',
		'audio/flac': '.flac',
		'audio/mp4': '.m4a',
		'audio/mpeg': '.mp3',
		'audio/ogg': '.ogg',
		'audio/wav': '.wav',
		'audio/x-wav': '.wav'
	};
	return extensions[mimeType];
}

function validImageSignature(mimeType: string, bytes: Uint8Array): boolean {
	if (mimeType === 'image/jpeg') {
		return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	}
	if (mimeType === 'image/png') {
		return (
			bytes.length >= 8 &&
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a
		);
	}
	return (
		mimeType === 'image/webp' &&
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

function isDuplicateColumnError(error: unknown): boolean {
	return error instanceof Error && /duplicate column name/i.test(error.message);
}

function authorized(request: Request, expectedToken: string): boolean {
	const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
	if (!match || expectedToken.length === 0) return false;
	const provided = Buffer.from(match[1]);
	const expected = Buffer.from(expectedToken);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJson(request: Request): Promise<unknown> {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(contentLength) && contentLength > maxMetadataBytes) {
		throw new RangeError('metadata too large');
	}
	if (!request.body) throw new SyntaxError('missing body');

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maxMetadataBytes) {
				await reader.cancel();
				throw new RangeError('metadata too large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseMetadata(value: unknown): { ok: true; value: ShareMetadata } | { ok: false; field: string } {
	if (!isRecord(value)) return { ok: false, field: 'body' };
	const title = boundedText(value.title, 500);
	const artists =
		typeof value.artists === 'string' && value.artists.length <= 1000 ? value.artists.trim() : null;
	const sourceId = boundedText(value.sourceId, 128);
	const accountId =
		value.accountId === undefined
			? undefined
			: typeof value.accountId === 'string' && value.accountId.length <= 512
				? value.accountId.trim()
				: null;
	const trackId = boundedText(value.trackId, 512);
	const playbackId =
		value.playbackId === undefined
			? undefined
			: typeof value.playbackId === 'string' && value.playbackId.length <= 512
				? value.playbackId.trim()
				: null;
	const quality = value.quality;
	const template = value.template;
	const cardSquare = value.cardSquare;
	const mode = value.mode;
	const durationMs = value.durationMs;
	if (!title) return { ok: false, field: 'title' };
	if (artists === null) return { ok: false, field: 'artists' };
	if (!sourceId) return { ok: false, field: 'sourceId' };
	if (accountId === null) return { ok: false, field: 'accountId' };
	if (!trackId) return { ok: false, field: 'trackId' };
	if (playbackId === null) return { ok: false, field: 'playbackId' };
	if (quality !== 'standard' && quality !== 'high' && quality !== 'lossless') {
		return { ok: false, field: 'quality' };
	}
	if (typeof template !== 'string' || !templates.has(template)) return { ok: false, field: 'template' };
	if (typeof cardSquare !== 'boolean') return { ok: false, field: 'cardSquare' };
	if (mode !== 'full' && mode !== 'clip') return { ok: false, field: 'mode' };
	if (!isIntegerInRange(durationMs, 0, maxDurationMs)) return { ok: false, field: 'durationMs' };
	if (mode === 'clip' && durationMs === 0) return { ok: false, field: 'durationMs' };
	if (!Array.isArray(value.lyrics) || value.lyrics.length > maxLyrics) {
		return { ok: false, field: 'lyrics' };
	}

	const lyrics: ShareMetadata['lyrics'] = [];
	for (const line of value.lyrics) {
		if (!isRecord(line)) return { ok: false, field: 'lyrics' };
		const text = boundedText(line.text, 4000);
		const translation =
			line.translation === undefined
				? undefined
				: typeof line.translation === 'string' && line.translation.length <= 4000
					? line.translation.trim()
					: null;
		if (
			!text ||
			translation === null ||
			!isIntegerInRange(line.atMs, 0, durationMs || maxDurationMs) ||
			!isIntegerInRange(line.endMs, line.atMs + 1, durationMs || maxDurationMs)
		) {
			return { ok: false, field: 'lyrics' };
		}
		const stageEndMs = line.stageEndMs;
		if (stageEndMs !== undefined && !isIntegerInRange(stageEndMs, line.atMs + 1, line.endMs)) return { ok: false, field: 'stageEndMs' };
		let words: ShareLyricWord[] | undefined;
		if (line.words !== undefined) {
			if (!Array.isArray(line.words) || line.words.length > 2000) return { ok: false, field: 'words' };
			words = [];
			for (const word of line.words) {
				if (!isRecord(word) || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 4000 ||
					!isIntegerInRange(word.startMs, line.atMs, line.endMs - 1) ||
					!isIntegerInRange(word.endMs, word.startMs + 1, line.endMs) ||
					(words.length > 0 && word.startMs < words[words.length - 1].startMs)) {
					return { ok: false, field: 'words' };
				}
				words.push({ text: word.text, startMs: word.startMs, endMs: word.endMs });
			}
		}
		lyrics.push({
			text,
			...(translation ? { translation } : {}),
			atMs: line.atMs,
			endMs: line.endMs,
			...(stageEndMs !== undefined ? { stageEndMs } : {}),
			...(words ? { words } : {})
		});
	}

	if (!Array.isArray(value.selectedLineIndexes)) return { ok: false, field: 'selectedLineIndexes' };
	const selectedLineIndexes: number[] = [];
	const seen = new Set<number>();
	for (const index of value.selectedLineIndexes) {
		if (!isIntegerInRange(index, 0, maxLyrics) || index >= lyrics.length || seen.has(index)) {
			return { ok: false, field: 'selectedLineIndexes' };
		}
		seen.add(index);
		selectedLineIndexes.push(index);
	}

	let hotComments: ShareHotComment[] | undefined;
	if (value.hotComments !== undefined) {
		if (!Array.isArray(value.hotComments) || value.hotComments.length > 10) return { ok: false, field: 'hotComments' };
		hotComments = [];
		for (const comment of value.hotComments) {
			if (!isRecord(comment) || typeof comment.text !== 'string' || !comment.text.trim() ||
				[...comment.text].length > 140 || typeof comment.author !== 'string' || comment.author.length > 128 ||
				!isIntegerInRange(comment.likes, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, field: 'hotComments' };
			hotComments.push({ text: comment.text.trim(), author: comment.author, likes: comment.likes });
		}
	}

	let clipStartMs: number | undefined;
	let clipEndMs: number | undefined;
	if (mode === 'clip') {
		if (selectedLineIndexes.length === 0) return { ok: false, field: 'selectedLineIndexes' };
		if (!isIntegerInRange(value.clipStartMs, 0, durationMs)) return { ok: false, field: 'clipStartMs' };
		if (!isIntegerInRange(value.clipEndMs, value.clipStartMs + 1, durationMs)) {
			return { ok: false, field: 'clipEndMs' };
		}
		const selectedLines = selectedLineIndexes.map((index) => lyrics[index]);
		const firstSelectedAt = Math.min(...selectedLines.map((line) => line.atMs));
		const lastSelectedEnd = Math.max(...selectedLines.map((line) => line.endMs));
		const expectedStart = Math.max(0, firstSelectedAt - 1000);
		const expectedEnd = Math.min(durationMs, lastSelectedEnd + 1000);
		if (value.clipStartMs !== expectedStart || value.clipEndMs !== expectedEnd) {
			return { ok: false, field: 'clipRange' };
		}
		clipStartMs = value.clipStartMs;
		clipEndMs = value.clipEndMs;
	} else if (value.clipStartMs !== undefined || value.clipEndMs !== undefined) {
		return { ok: false, field: 'clipRange' };
	}

	let sourceUrl: string | undefined;
	if (value.sourceUrl !== undefined) {
		if (typeof value.sourceUrl !== 'string' || value.sourceUrl.length > 2048) {
			return { ok: false, field: 'sourceUrl' };
		}
		try {
			const source = new URL(value.sourceUrl);
			if (
				(source.protocol !== 'http:' && source.protocol !== 'https:') ||
				source.username.length > 0 ||
				source.href.includes('@')
			) {
				return { ok: false, field: 'sourceUrl' };
			}
			sourceUrl = source.toString();
		} catch {
			return { ok: false, field: 'sourceUrl' };
		}
	}
	let coverHash: string | undefined;
	if (value.coverHash !== undefined) {
		if (typeof value.coverHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.coverHash)) {
			return { ok: false, field: 'coverHash' };
		}
		coverHash = value.coverHash;
	}

	return {
		ok: true,
		value: {
			title,
			artists,
			sourceId,
			...(accountId ? { accountId } : {}),
			trackId,
			...(playbackId ? { playbackId } : {}),
			quality,
			template: template as ShareMetadata['template'],
			cardSquare,
			mode,
			durationMs,
			lyrics,
			selectedLineIndexes,
			...(hotComments?.length ? { hotComments } : {}),
			...(clipStartMs === undefined ? {} : { clipStartMs, clipEndMs }),
			...(sourceUrl ? { sourceUrl } : {}),
			...(coverHash ? { coverHash } : {})
		}
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): string | null {
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return text.length > 0 && text.length <= maximum ? text : null;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function json(
	body: Record<string, unknown>,
	status: number,
	headers: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}
