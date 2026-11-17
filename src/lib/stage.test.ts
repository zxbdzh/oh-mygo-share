import { describe, expect, it } from 'vitest';
import { motionFactor, prepareStageLyrics, stagePreferences, stageSnapshot, wordPose } from './stage';

describe('stage lyric timing', () => {
	it('preserves source word timing but spreads translated text within the original line', () => {
		const source = [{
			text: '你好世界', translation: 'Hello world', atMs: 1000, endMs: 5000,
			words: [
				{ text: '你好', startMs: 1100, endMs: 1800 },
				{ text: '世界', startMs: 2600, endMs: 4000 }
			]
		}];
		expect(prepareStageLyrics(source, 'original')[0].words).toEqual(source[0].words);
		const translated = prepareStageLyrics(source, 'translation')[0];
		expect(translated.text).toBe('Hello world');
		expect(translated.words.map((word) => word.text).join('')).toBe('Hello world');
		expect(translated.words[0].startMs).toBe(1000);
		expect(translated.words.at(-1)?.endMs).toBe(4400);
	});

	it('uses the audio position for intro, interlude, translated fallback, and hot-comment slots', () => {
		const lines = prepareStageLyrics([
			{ text: 'First', atMs: 10_000, endMs: 12_000 },
			{ text: 'Second', atMs: 30_000, endMs: 32_000 }
		], 'translation');
		const comments = [{ text: 'Keep this moment', author: 'Listener', likes: 12 }];
		expect(lines[0].text).toBe('First');
		expect(stageSnapshot(lines, 500, 50_000, comments, true).interlude).toMatchObject({ fromMs: 0, toMs: 10_000 });
		expect(stageSnapshot(lines, 2000, 50_000, comments, true).comment?.text).toBe('Keep this moment');
		expect(stageSnapshot(lines, 11_000, 50_000, comments, true).comment).toBeNull();
		expect(stageSnapshot(lines, 20_000, 50_000, comments, false).interlude).toMatchObject({ fromMs: 12_000, toMs: 30_000 });
		expect(stageSnapshot(lines, 31_000, 50_000, comments, true).current?.text).toBe('Second');
	});

	it('renders the same word pose after seeking back and suppresses displacement for reduced motion', () => {
		const word = { text: '你', startMs: 1000, endMs: 1600 };
		const before = wordPose(word, 1100, 7, 1);
		wordPose(word, 7000, 7, 1);
		expect(wordPose(word, 1100, 7, 1)).toEqual(before);
		expect(wordPose(word, 900, 7, 1).opacity).toBe(0);
		const still = wordPose(word, 1100, 7, 0);
		expect(Math.abs(still.x) + Math.abs(still.y) + Math.abs(still.rotation) + still.blur).toBe(0);
		expect(still.scale).toBe(1);
		expect(motionFactor('lively', true)).toBe(0);
		expect(motionFactor('gentle', false)).toBe(.45);
	});

	it('ignores obsolete saved options without losing valid display preferences', () => {
		expect(stagePreferences({ style: 'deleted-style', intensity: 'lively', language: 'translation', sparks: 'true' }))
			.toMatchObject({ style: 'flow', intensity: 'lively', language: 'translation', sparks: false });
		expect(stagePreferences(null).style).toBe('flow');
	});

	it('keeps the original vocal end even when clip-selection bounds extend to the next line', () => {
		const lines = prepareStageLyrics([
			{ text: 'A short line', atMs: 0, endMs: 30000, stageEndMs: 6000 },
			{ text: 'Next', atMs: 30000, endMs: 34000 }
		], 'original');
		expect(lines[0].words.at(-1)?.endMs).toBe(5100);
		expect(stageSnapshot(lines, 12000, 40000).interlude).toMatchObject({ fromMs: 6000, toMs: 30000 });
	});
});
