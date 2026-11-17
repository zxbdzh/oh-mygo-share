import type { ShareHotComment, ShareLyric, ShareLyricWord } from './types';

export type StageStyle = 'flow' | 'partita' | 'tilt' | 'spotlight' | 'wave';
export type StageIntensity = 'gentle' | 'standard' | 'lively';
export type StageLanguage = 'bilingual' | 'original' | 'translation';
export type StageLine = ShareLyric & { words: ShareLyricWord[] };

export const stageStyles: { value: StageStyle; label: string }[] = [
	{ value: 'flow', label: '流光' }, { value: 'partita', label: '云阶' },
	{ value: 'tilt', label: '倾诉' }, { value: 'spotlight', label: '聚光' },
	{ value: 'wave', label: '声波' }
];
export const stageIntensities: { value: StageIntensity; label: string }[] = [
	{ value: 'gentle', label: '舒缓' }, { value: 'standard', label: '标准' }, { value: 'lively', label: '活跃' }
];
export const stageLanguages: { value: StageLanguage; label: string }[] = [
	{ value: 'bilingual', label: '双语' }, { value: 'original', label: '原文' },
	{ value: 'translation', label: '译文' }
];

export type StagePreferences = {
	style: StageStyle;
	intensity: StageIntensity;
	language: StageLanguage;
	sparks: boolean;
	hotComments: boolean;
};

export function stagePreferences(value: unknown): StagePreferences {
	const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return {
		style: stageStyles.some((option) => option.value === saved.style) ? saved.style as StageStyle : 'flow',
		intensity: stageIntensities.some((option) => option.value === saved.intensity) ? saved.intensity as StageIntensity : 'standard',
		language: stageLanguages.some((option) => option.value === saved.language) ? saved.language as StageLanguage : 'bilingual',
		sparks: saved.sparks === true,
		hotComments: saved.hotComments !== false
	};
}

export function spreadWords(text: string, startMs: number, endMs: number): ShareLyricWord[] {
	const parts: string[] = [];
	let pending = '';
	const flush = () => { if (pending) parts.push(pending); pending = ''; };
	for (const character of text) {
		if (/\s/u.test(character)) {
			if (pending) { pending += ' '; flush(); }
		} else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)) {
			flush();
			parts.push(character);
		} else pending += character;
	}
	flush();
	const length = Math.max(1, parts.reduce((total, part) => total + [...part.trim()].length, 0));
	const span = Math.max(0, endMs - startMs) * 0.85;
	let elapsed = 0;
	return parts.map((part) => {
		const from = startMs + Math.round(span * elapsed / length);
		elapsed += [...part.trim()].length;
		return { text: part, startMs: from, endMs: startMs + Math.round(span * elapsed / length) };
	});
}

export function prepareStageLyrics(lyrics: ShareLyric[], language: StageLanguage): StageLine[] {
	return lyrics.map((line) => {
		const translated = language === 'translation' && Boolean(line.translation?.trim());
		const text = translated ? line.translation!.trim() : line.text;
		const endMs = line.stageEndMs ?? line.endMs;
		return {
			...line, text, endMs,
			translation: language === 'bilingual' ? line.translation : undefined,
			// 译文与原词不共用逐词时间；旧分享缺逐词数据时与桌面版一样按行区间分配显示动效。
			words: !translated && line.words?.length ? line.words : spreadWords(text, line.atMs, endMs)
		};
	}).sort((first, second) => first.atMs - second.atMs);
}

export const clamp = (value: number, minimum = 0, maximum = 1): number => Math.min(maximum, Math.max(minimum, value));
export const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;
export const easeOut = (value: number): number => 1 - (1 - clamp(value)) ** 3;
export const random = (seed: number, offset: number): number => {
	const value = Math.sin(seed + offset) * 10000;
	return value - Math.floor(value);
};
export const spring = (seconds: number): number =>
	seconds <= 0 ? 0 : 1 - Math.exp(-10 * seconds) * (Math.cos(10 * seconds) + Math.sin(10 * seconds));
export const motionFactor = (intensity: StageIntensity, reduced: boolean): number =>
	reduced ? 0 : intensity === 'gentle' ? .45 : intensity === 'lively' ? 1.25 : 1;

export function stageSnapshot(lines: StageLine[], position: number, duration: number, comments: ShareHotComment[] = [], showComments = false) {
	let index = -1;
	for (let cursor = 0; cursor < lines.length && lines[cursor].atMs <= position; cursor++) index = cursor;
	const current = lines[index] ?? null;
	const next = lines[index + 1] ?? null;
	let interlude: { fromMs: number; toMs: number; progress: number } | null = null;
	if (!current || position > current.endMs + 1000 && (next?.atMs ?? duration) - current.endMs > 4000) {
		const fromMs = current?.endMs ?? 0;
		const toMs = next?.atMs ?? duration;
		interlude = { fromMs, toMs, progress: clamp((position - fromMs) / Math.max(100, toMs - fromMs)) };
	}
	let comment: ShareHotComment | null = null;
	if (showComments && comments.length > 0 && interlude && interlude.toMs - interlude.fromMs >= 8000 &&
		position >= interlude.fromMs + 1200 && position < interlude.toMs - 1000) {
		const interval = interlude.toMs - interlude.fromMs - 2200;
		const slots = Math.max(1, Math.round(interval / 10000));
		const slot = Math.min(slots - 1, Math.floor((position - interlude.fromMs - 1200) / (interval / slots)));
		comment = comments[(Math.max(0, index + 1) + slot) % comments.length];
	}
	return {
		index, current, next, interlude, comment,
		previous: index > 0 && current && position - current.atMs < 400 ? lines[index - 1] : null,
		previousOpacity: current ? 1 - easeOut((position - current.atMs) / 400) : 0
	};
}

export function wordPose(word: ShareLyricWord, position: number, seed: number, motion: number) {
	const shape = {
		x: (random(seed, 1) - .5) * 36, y: (random(seed, 2) - .5) * 36,
		rotation: (random(seed, 3) - .5) * 10, scale: 1.1 + random(seed, 4) * .2,
		drift: (random(seed, 5) - .5) * 10
	};
	const since = (position - word.startMs + 80) / 1000;
	const after = (position - Math.max(word.endMs, word.startMs + 150)) / 1000;
	const singing = Math.max(.08, (Math.max(word.endMs, word.startMs + 150) - word.startMs) / 1000);
	const entry = spring(since);
	let x = lerp(shape.x + Math.sin(shape.y) * 100, shape.x, entry);
	let y = lerp(shape.y + Math.cos(shape.x) * 50, shape.y, entry);
	let scale = lerp(.5, shape.scale * 1.4, entry);
	let rotation = lerp(shape.rotation + 20, shape.rotation, entry);
	let opacity = clamp(since / .1);
	let brightness = lerp(.5, 1, clamp(since / singing));
	let glow = clamp(since / Math.max(.08, .3 * singing));
	if (after > 0) {
		scale = lerp(shape.scale * 1.4, shape.scale, easeOut(after / .5));
		opacity = lerp(1, .82, easeOut(after / .5));
		rotation = shape.rotation + shape.drift * clamp(after / 5);
		brightness = lerp(1, .5, easeOut(after / .8));
		glow = 1 - clamp(after / .9);
	}
	x *= motion;
	y *= motion;
	return { x, y, rotation: rotation * motion, scale: 1 + (scale - 1) * motion, opacity,
		brightness, glow: glow * motion, blur: 10 * (1 - clamp(since / .2)) * motion };
}

export function stageUnits(words: ShareLyricWord[]): [number, number][] {
	const units: [number, number][] = [];
	let from = 0;
	for (let index = 0; index < words.length; index++) {
		const text = words[index].text;
		if (index === from && units.length > 0 && /^[\s\p{P}]+$/u.test(text)) {
			units[units.length - 1][1] = index + 1;
			from = index + 1;
			continue;
		}
		const last = [...text].at(-1) ?? '';
		if (index + 1 === words.length || /[\s\p{P}]/u.test(last) && !/['’\-]/u.test(last)) {
			const length = index + 1 - from;
			const count = length <= 6 ? 1 : Math.ceil(length / 4);
			for (let part = 0; part < count; part++) units.push([
				from + Math.floor(length * part / count), from + Math.floor(length * (part + 1) / count)
			]);
			from = index + 1;
		}
	}
	return units;
}
