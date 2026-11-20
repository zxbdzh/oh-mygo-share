import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { processMediaFile } from './media-processor';
import type { ShareMetadata } from './share-api';

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const mediaToolsAvailable = [ffmpeg, ffprobe].every((tool) => {
	const result = spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true });
	return !result.error && result.status === 0;
});

describe('media processing', () => {
	it.skipIf(!mediaToolsAvailable)('stores only the requested continuous clip with its measured duration', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'oh-mygo-share-media-'));
		try {
			const source = join(directory, 'source.wav');
			const output = join(directory, 'clip.wav');
			await execute(ffmpeg, [
				'-v',
				'error',
				'-nostdin',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:sample_rate=44100:duration=6',
				'-c:a',
				'pcm_s16le',
				source
			]);

			const metadata: ShareMetadata = {
				title: 'Blue Hour',
				artists: 'A. Example',
				sourceId: 'catalog',
				trackId: 'track-1',
				quality: 'high',
				template: 'cinema',
				cardSquare: false,
				mode: 'clip',
				durationMs: 6000,
				lyrics: [{ text: 'Selected', atMs: 2000, endMs: 3000 }],
				selectedLineIndexes: [0],
				clipStartMs: 1234,
				clipEndMs: 1344
			};
			await expect(processMediaFile(source, join(directory, 'mislabeled.mp3'), { ...metadata, mode: 'full' }, 'audio/mpeg')).rejects.toThrow('media_type_mismatch');

			const result = await processMediaFile(source, output, metadata, 'audio/wav');
			const outputStat = await stat(output);
			expect(outputStat.size).toBeGreaterThan(0);
			expect(result.mimeType).toBe('audio/wav');
			expect(result.durationMs).toBeGreaterThanOrEqual(109);
			expect(result.durationMs).toBeLessThanOrEqual(111);
			const pcm = (path: string) => execute(ffmpeg, [
				'-v', 'error', '-i', path, '-f', 's16le', 'pipe:1'
			], { encoding: 'buffer' });
			const [original, cropped] = await Promise.all([pcm(source), pcm(output)]);
			const firstByte = Math.round(metadata.clipStartMs! * 44.1) * 2;
			const lastByte = Math.round(metadata.clipEndMs! * 44.1) * 2;
			expect(cropped.stdout).toEqual(original.stdout.subarray(firstByte, lastByte));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
