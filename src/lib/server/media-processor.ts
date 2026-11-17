import { execFile } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { MediaProcessor } from './share-api';

const execute = promisify(execFile);

const supportedTypes: Record<string, string> = {
	'audio/aac': 'aac',
	'audio/flac': 'flac',
	'audio/mp4': 'm4a',
	'audio/mpeg': 'mp3',
	'audio/ogg': 'ogg',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav'
};

const encoders: Record<string, string[]> = {
	aac: ['-c:a', 'aac', '-b:a', '256k'],
	flac: ['-c:a', 'flac'],
	m4a: ['-c:a', 'aac', '-b:a', '256k'],
	mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
	ogg: ['-c:a', 'libvorbis', '-q:a', '6'],
	wav: ['-c:a', 'pcm_s16le']
};

type ProbeResult = { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }> };

const containerNames: Record<string, string> = { aac: 'aac', flac: 'flac', m4a: 'mp4', mp3: 'mp3', ogg: 'ogg', wav: 'wav' };

export const processMediaFile: MediaProcessor = async (inputPath, outputPath, metadata, inputMimeType) => {
	const extension = supportedTypes[inputMimeType];
	if (!extension) throw new Error('unsupported_media_type');

	const source = await probe(inputPath);
	const sourceDurationMs = durationMs(source);
	if (!source.streams?.some((stream) => stream.codec_type === 'audio')) {
		throw new Error('audio_stream_missing');
	}
	if (!source.format?.format_name?.split(',').includes(containerNames[extension])) throw new Error('media_type_mismatch');
	if (source.streams.some((stream) => stream.codec_type !== 'audio' && !(stream.codec_type === 'video' && stream.disposition?.attached_pic === 1))) throw new Error('unsupported_media_stream');

	if (metadata.mode === 'full') {
		await copyFile(inputPath, outputPath);
		return { mimeType: inputMimeType === 'audio/x-wav' ? 'audio/wav' : inputMimeType, durationMs: sourceDurationMs };
	}

	const startMs = metadata.clipStartMs;
	const endMs = metadata.clipEndMs;
	if (startMs === undefined || endMs === undefined || endMs > sourceDurationMs + 250) {
		throw new Error('clip_range_mismatch');
	}

	await execute(
		process.env.FFMPEG_PATH ?? 'ffmpeg',
		[
			'-v',
			'error',
			'-nostdin',
			'-y',
			'-ss',
			seconds(startMs),
			'-i',
			inputPath,
			'-t',
			seconds(endMs - startMs),
			'-map',
			'0:a:0',
			'-vn',
			// 音频包直接复制会泄露边界外的采样，必须解码后精确裁剪。
			...encoders[extension],
			'-map_metadata',
			'-1',
			'-threads',
			'1',
			outputPath
		],
		{ windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 }
	);
	try {
		const processed = await probe(outputPath);
		const processedDurationMs = durationMs(processed);
		if (
			!processed.streams?.some((stream) => stream.codec_type === 'audio') ||
			Math.abs(processedDurationMs - (endMs - startMs)) > 100
		) {
			throw new Error('processed_clip_duration_mismatch');
		}
		return {
			mimeType: inputMimeType === 'audio/x-wav' ? 'audio/wav' : inputMimeType,
			durationMs: processedDurationMs
		};
	} catch (error) {
		await rm(outputPath, { force: true });
		throw error;
	}
};

async function probe(path: string): Promise<ProbeResult> {
	const { stdout } = await execute(
		process.env.FFPROBE_PATH ?? 'ffprobe',
		['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', path],
		{ windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
	);
	return JSON.parse(stdout) as ProbeResult;
}

function durationMs(result: ProbeResult): number {
	const seconds = Number(result.format?.duration);
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('invalid_audio_duration');
	return Math.round(seconds * 1000);
}

function seconds(milliseconds: number): string {
	return (milliseconds / 1000).toFixed(3);
}
