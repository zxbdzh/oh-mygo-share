import type { ShareHotComment, ShareLyric, ShareLyricWord } from './types';
import { createStageSurface } from './stage-surface';
import {
	clamp, easeOut, lerp, motionFactor, prepareStageLyrics, random, spring, stageSnapshot,
	stageUnits, wordPose, type StageIntensity, type StageLanguage, type StageLine, type StageStyle
} from './stage';

export type StageRendererOptions = {
	lyrics: ShareLyric[];
	currentTimeMs: number;
	durationMs: number;
	playing: boolean;
	audio: HTMLAudioElement | null;
	coverUrl?: string;
	title: string;
	style: StageStyle;
	intensity: StageIntensity;
	sparks: boolean;
	language: StageLanguage;
	hotComments?: ShareHotComment[];
	showHotComments: boolean;
	getLevels: () => number[] | null;
};

type PositionedWord = { word: ShareLyricWord; index: number; width: number };
const family = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif";
const japaneseFamily = "'Yu Gothic UI', 'Hiragino Sans', 'Meiryo', sans-serif";

export function createStageRenderer(canvas: HTMLCanvasElement, getOptions: () => StageRendererOptions, fallbackCanvas: HTMLCanvasElement) {
	const surface = createStageSurface(canvas, fallbackCanvas, render);
	if (!surface) return { render() {}, destroy() {} };
	let painter = surface.painter!;
	const reduce = matchMedia('(prefers-reduced-motion: reduce)');
	let animation = 0;
	let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
	let destroyed = false;
	let cachedLyrics: ShareLyric[] | undefined;
	let cachedLanguage: StageLanguage | undefined;
	let lines: StageLine[] = [];
	let coverUrl: string | undefined;
	let cover: HTMLImageElement | undefined;
	let width = 1;
	let height = 1;
	let motion = 1;
	let options: StageRendererOptions;
	let position = 0;
	let lastFrame = 0;
	let accent = '#b5b5ba';
	let lyricFamily = family;
	const textWidths = new Map<string, number>();

	function font(size: number, weight = 800, italic = false, caption = false) {
		painter.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${caption ? family : lyricFamily}`;
	}

	function measure(text: string, size: number, weight = 800, caption = false) {
		const key = `${caption ? family : lyricFamily}:${size}:${weight}:${text}`;
		let value = textWidths.get(key);
		if (value === undefined) {
			font(size, weight, false, caption);
			value = painter.measureText(text).width;
			textWidths.set(key, value);
		}
		return value;
	}

	function cancel() {
		cancelAnimationFrame(animation);
		if (boundaryTimer) clearTimeout(boundaryTimer);
		boundaryTimer = undefined;
	}

	function wrap(words: ShareLyricWord[], size: number, available: number, extra = 0, weight = 800) {
		const rows: PositionedWord[][] = [[]];
		let rowWidth = 0;
		words.forEach((word, index) => {
			const wordWidth = measure(word.text, size, weight);
			if (rows.at(-1)!.length > 0 && rowWidth + wordWidth > available) {
				rows.push([]);
				rowWidth = 0;
			}
			rows.at(-1)!.push({ word, index, width: wordWidth });
			rowWidth += wordWidth + extra;
		});
		return rows;
	}

	function sparks(word: ShareLyricWord, x: number, y: number, wordWidth: number, size: number, last: boolean, opacity: number) {
		const since = (position - word.startMs) / 1000;
		if (!options.sparks || motion === 0 || since < 0 || since >= .6) return;
		const progress = since / .6;
		const count = last ? 16 : 9;
		const reach = Math.max(wordWidth, size) * .75 * (last ? 1.6 : 1) * motion;
		painter.save();
		painter.strokeStyle = accent;
		painter.globalAlpha = opacity * .9 * (1 - progress) ** 2;
		painter.lineWidth = .8 + 1.6 * (1 - progress);
		for (let index = 0; index < count; index++) {
			const angle = 2 * Math.PI * (index + random(word.startMs, index) * .7) / count;
			const dx = Math.cos(angle), dy = Math.sin(angle);
			const edge = wordWidth / 2 * .7 * Math.abs(dx) + size / 2 * .7 * Math.abs(dy);
			const head = edge + reach * (.55 + .45 * random(word.startMs, index + 50)) * easeOut(progress);
			const tail = Math.max(edge, head - reach * .3 * (1 - progress));
			painter.beginPath();
			painter.moveTo(x + dx * tail, y + dy * tail);
			painter.lineTo(x + dx * head, y + dy * head);
			painter.stroke();
		}
		painter.restore();
	}

	function flowWord(item: PositionedWord, line: StageLine, x: number, y: number, size: number, fade: number, factor = 1, last = false) {
		const pose = wordPose(item.word, position, line.atMs + item.index, motion);
		painter.save();
		painter.translate(x + pose.x / factor, y + pose.y / factor);
		painter.rotate(pose.rotation / factor * Math.PI / 180);
		painter.scale(pose.scale, pose.scale);
		font(size);
		painter.textAlign = 'center';
		painter.textBaseline = 'middle';
		painter.globalAlpha = fade * pose.opacity * pose.brightness;
		painter.fillStyle = '#fff';
		if (pose.blur > .3) painter.filter = `blur(${pose.blur}px)`;
		painter.shadowColor = accent;
		painter.shadowBlur = size * .3 * pose.glow;
		painter.fillText(item.word.text, 0, 0);
		painter.restore();
		sparks(item.word, x + pose.x / factor, y + pose.y / factor, item.width, size, last, fade);
	}

	function flow(line: StageLine, size: number, fade: number) {
		const gap = size * .5;
		const maxWord = Math.max(1, ...line.words.map((word) => measure(word.text, size)));
		size *= Math.min(1, width * .6 / maxWord);
		const rows = wrap(line.words, size, width * .78, gap);
		const seed = line.atMs;
		const justify = Math.abs(Math.floor(seed)) % 3;
		const lift = [-.14, 0, .12][Math.abs(Math.floor(seed * 2)) % 3] * height * motion;
		const rowHeight = Math.min(size * 1.8, height * .65 / Math.max(1, rows.length));
		rows.forEach((row, rowIndex) => {
			const rowWidth = row.reduce((total, item) => total + item.width, 0) + gap * Math.max(0, row.length - 1);
			let start = justify === 0 ? width * .11 : justify === 2 ? width * .89 - rowWidth : (width - rowWidth) / 2;
			const y = height * .44 + (rowIndex - (rows.length - 1) / 2) * rowHeight + lift;
			row.forEach((item) => {
				flowWord(item, line, start + item.width / 2, y, size, fade, 1, item.index === line.words.length - 1);
				start += item.width + gap;
			});
		});
	}

	function partita(line: StageLine, base: number, fade: number) {
		const units = stageUnits(line.words);
		const count = Math.min(units.length, Math.max(1, Math.floor(height * .65 / 100)));
		if (!count) return;
		let fromUnit = 0;
		for (let row = 0; row < count; row++) {
			const remaining = units.length - fromUnit;
			const average = remaining / (count - row);
			const number = row === count - 1 ? remaining : clamp(Math.round(average + (random(line.atMs / 1000, row + 1) - .5) * average), 1, remaining - (count - row - 1));
			const from = units[fromUnit][0], to = units[fromUnit + number - 1][1];
			const words = line.words.slice(from, to);
			const rawScale = .8 + random(line.atMs / 1000, row + 20) * .9;
			const rawSize = base * .8 * rawScale;
			const textWidth = words.reduce((total, word) => total + measure(word.text, rawSize), 0);
			const size = rawSize * Math.min(1, width * .65 / Math.max(1, textWidth + words.length * rawSize * .35), height * .6 / count / (rawSize * 1.8));
			const gap = size * .35;
			const rowWidth = words.reduce((total, word) => total + measure(word.text, size), 0) + gap * (words.length - 1);
			const since = (position - words[0].startMs + 80) / 1000;
			const side = row % 2 === 0 ? -1 : 1;
			const stagger = Math.min(width * .12, 20 + random(line.atMs / 1000, row + 40) * 80);
			const center = width / 2 + side * (stagger + 40 * (1 - spring(since))) * motion;
			const y = height * .44 + (row - (count - 1) / 2) * Math.min(base * 2.5, height * .65 / count);
			let start = center - rowWidth / 2;
			const rowFade = fade * clamp(since / .1);
			words.forEach((word, index) => {
				const wordWidth = measure(word.text, size);
				flowWord({ word, index: from + index, width: wordWidth }, line, start + wordWidth / 2, y, size, rowFade, 3, from + index === line.words.length - 1);
				start += wordWidth + gap;
			});
			painter.save();
			painter.globalAlpha = rowFade * (position < words.at(-1)!.endMs ? .8 : .22);
			painter.strokeStyle = position < words.at(-1)!.endMs ? accent : '#fff';
			const guide = easeOut(since / .4);
			const edge = center + side * (rowWidth / 2 + 12);
			painter.beginPath();
			painter.moveTo(edge, y + size * .8);
			painter.lineTo(edge - side * (rowWidth + 30) * guide, y + size * .8);
			painter.moveTo(edge - side * 8, y + size * .8 + 8);
			painter.lineTo(edge - side * 8, y + size * .8 + 8 - 24 * guide);
			painter.stroke();
			painter.restore();
			fromUnit += number;
		}
	}

	function tilt(line: StageLine, fade: number) {
		const units = stageUnits(line.words);
		if (!units.length) return;
		const characters = [...line.text.replace(/\s/gu, '')].length;
		const score = Math.log(characters + 4) / Math.log(24) * (random(line.atMs / 1000, 1) * .6 + .7) * .75;
		const desired = score < .45 ? 1 : score < 1.05 ? 2 : score < 1.7 ? 3 : 4;
		let count = Math.min(desired, units.length);
		let parts: ShareLyricWord[][] = [];
		let size = Math.min(90, width * .06875);
		while (count <= Math.min(4, units.length)) {
			parts = [];
			const lengths = units.map(([from, to]) => [...line.words.slice(from, to).map((word) => word.text).join('').trim()].length);
			let fromUnit = 0;
			for (let index = 1; index < count; index++) {
				let best = fromUnit + 1, distance = Infinity;
				for (let cut = fromUnit + 1; cut <= units.length - (count - index); cut++) {
					let candidate = Math.abs(lengths.slice(0, cut).reduce((sum, value) => sum + value, 0) - characters * index / count);
					if (/[\p{P}]$/u.test(line.words[units[cut - 1][1] - 1].text.trim())) candidate -= characters * .15;
					if (candidate < distance) { best = cut; distance = candidate; }
				}
				parts.push(line.words.slice(units[fromUnit][0], units[best - 1][1]));
				fromUnit = best;
			}
			parts.push(line.words.slice(units[fromUnit][0]));
			const widest = Math.max(...parts.map((part) => {
				const text = part.map((word) => word.text).join('').trim();
				return measure(text, size, 400) + [...text].length * size * .15;
			}));
			if (widest <= width * .82 || count === Math.min(4, units.length)) {
				size *= Math.min(1, width * .82 / Math.max(1, widest));
				break;
			}
			count++;
		}
		const candidates = parts.map((_, index) => index).filter((index) => random(line.atMs / 1000, 100 + index) < .35);
		const leanIndex = candidates[Math.floor(random(line.atMs / 1000, 200) * candidates.length)] ?? -1;
		const baseSize = size;
		parts.forEach((words, partIndex) => {
			const lean = partIndex === leanIndex;
			const length = words.map((word) => [...word.text.trim()].length).reduce((sum, value) => sum + value, 0);
			const before = partIndex > 0 ? parts[partIndex - 1].map((word) => [...word.text.trim()].length).reduce((sum, value) => sum + value, 0) : 0;
			const tail = partIndex === parts.length - 1 && parts.length > 1 && !lean && length <= 2 && length * 2 <= before;
			const size = baseSize * (tail ? 1.18 : 1);
			const weight = lean ? 300 : 400;
			const spacing = size * (lean ? .15 : .08);
			const since = (position - words[0].startMs + 250) / 1000;
			const incoming = 1 - (1 - clamp(since / (lean ? .6 : .55))) ** 2;
			const chars = words.flatMap((word) => [...word.text].map((text, index, all) => ({
				text, start: word.startMs + index * (word.endMs - word.startMs) / all.length,
				duration: (word.endMs - word.startMs) / all.length, word, first: index === 0
			})));
			const partWidth = chars.reduce((total, character) => total + measure(character.text, size, weight) + spacing, 0);
			let start = (width - partWidth) / 2;
			const y = height * .44 + (partIndex - (parts.length - 1) / 2) * (size * 1.5 + 14) + 24 * (1 - incoming) * motion;
			chars.forEach((character, index) => {
				const charWidth = measure(character.text, size, weight);
				const elapsed = (position - character.start) / 1000;
				const duration = clamp(character.duration / 1000, .2, .9);
				const pulse = elapsed < 0 ? 0 : elapsed <= duration ? Math.sin(elapsed / duration * Math.PI) : .25 * clamp((elapsed - duration) / (duration * 1.2));
				const shown = 1 - (1 - clamp((since - index * (lean ? .05 : .04)) / .5)) ** 2;
				painter.save();
				painter.globalAlpha = fade * incoming * shown;
				painter.fillStyle = lean ? accent : '#fff';
				painter.translate(start + charWidth / 2, y + (lean ? size / 6 * (2 - shown) * (index % 2 === 0 ? -1 : 1) * motion : 0));
				painter.scale(1 + pulse * .18 * motion, 1 + pulse * .18 * motion);
				font(size, weight, lean);
				painter.textAlign = 'center';
				painter.textBaseline = 'middle';
				painter.fillText(character.text, 0, 0);
				painter.restore();
				if (character.first) sparks(character.word, start + charWidth / 2, y, charWidth, size, partIndex === parts.length - 1 && index === chars.length - 1, fade);
				start += charWidth + spacing;
			});
		});
	}

	function focus(line: StageLine, size: number, fade: number, levels: number[] | null) {
		const wave = options.style === 'wave';
		if (!wave && motion > 0) {
			const progress = clamp((position - line.atMs) / Math.max(100, line.endMs - line.atMs));
			const x = width * (.5 + (progress - .5) * .3 * motion), y = height * .4;
			const radius = Math.min(220, width * .4);
			const halo = painter.createRadialGradient(x, y, 0, x, y, radius);
			halo.addColorStop(0, `rgba(210,190,240,${.18 * motion * fade})`);
			halo.addColorStop(1, 'rgba(210,190,240,0)');
			painter.fillStyle = halo;
			painter.fillRect(0, 0, width, height);
		}
		const maxWord = Math.max(1, ...line.words.map((word) => measure(word.text, size, 700)));
		size *= Math.min(1, width * .72 / maxWord);
		const gap = size * .06;
		const rows = wrap(line.words, size, width * .82, gap, 700);
		rows.forEach((row, rowIndex) => {
			const rowWidth = row.reduce((total, word) => total + word.width, 0) + gap * (row.length - 1);
			let start = (width - rowWidth) / 2;
			const y = height * .4 + (rowIndex - (rows.length - 1) / 2) * size * 1.45;
			row.forEach((item) => {
				const word = item.word;
				const active = position >= word.startMs && position < word.endMs;
				const scale = active ? 1 + .055 * motion * Math.sin(Math.PI * clamp((position - word.startMs) / Math.max(100, word.endMs - word.startMs))) : 1;
				painter.save();
				painter.translate(start + item.width / 2, y);
				painter.scale(scale, scale);
				font(size, 700);
				painter.textAlign = 'center';
				painter.textBaseline = 'middle';
				painter.fillStyle = '#fff';
				painter.globalAlpha = fade * (active ? 1 : position >= word.startMs ? .88 : .45);
				painter.fillText(word.text, 0, 0);
				painter.restore();
				sparks(word, start + item.width / 2, y, item.width, size, item.index === line.words.length - 1, fade);
				start += item.width + gap;
			});
		});
		if (wave) {
			const waveWidth = Math.min(300, width * .7);
			const y = Math.min(height - 105, height * .64 + (rows.length - 1) * size * .4);
			painter.save();
			painter.globalAlpha = fade * .8;
			painter.fillStyle = accent;
			if (!levels || motion === 0) painter.fillRect((width - waveWidth) / 2, y, waveWidth, 1);
			else levels.forEach((level, index) => {
				const barHeight = 2 + clamp(level) * 44 * motion;
				const pitch = waveWidth / levels.length;
				painter.fillRect((width - waveWidth) / 2 + index * pitch, y - barHeight / 2, Math.max(2, pitch - 4), barHeight);
			});
			painter.restore();
		}
	}

	function centerText(text: string, y: number, size: number, opacity: number, weight = 600, available = width * .84, maxLines = 2) {
		font(size, weight, false, true);
		painter.fillStyle = '#fff';
		painter.globalAlpha = opacity;
		painter.textAlign = 'center';
		painter.textBaseline = 'middle';
		const rows: string[] = [];
		let row = '';
		for (const character of text) {
			// 允许句尾标点略超出行宽，避免热评最后只剩一个孤立句号。
			const closingMark = '，。！？、；：…）】」』,.!?;:)]'.includes(character);
			if (measure(row + character, size, weight, true) > available && row && !closingMark) { rows.push(row); row = ''; }
			row += character;
		}
		if (row) rows.push(row);
		rows.slice(0, maxLines).forEach((value, index) => painter.fillText(value, width / 2, y + index * size * 1.5));
		painter.globalAlpha = 1;
	}

	function interlude(progress: number, levels: number[] | null) {
		const energy = levels ? levels.reduce((sum, level) => sum + level, 0) / levels.length : 0;
		const breath = 1 + motion * (.018 * Math.sin(position / 1000 * 1.1) + .045 * clamp(energy));
		const size = Math.min(164, width * .4, height * .4);
		const x = (width - size * breath) / 2, y = height * .43 - size * breath / 2;
		painter.save();
		painter.beginPath();
		painter.roundRect(x, y, size * breath, size * breath, 18);
		painter.clip();
		if (cover?.complete && cover.naturalWidth > 0) {
			const side = Math.min(cover.naturalWidth, cover.naturalHeight);
			painter.drawImage(cover, (cover.naturalWidth - side) / 2, (cover.naturalHeight - side) / 2, side, side, x, y, size * breath, size * breath);
		} else {
			painter.fillStyle = 'rgba(255,255,255,.08)';
			painter.fillRect(x, y, size * breath, size * breath);
		}
		painter.restore();
		painter.fillStyle = 'rgba(255,255,255,.15)';
		painter.fillRect((width - size) / 2, y + size * breath + 26, size, 2);
		painter.fillStyle = accent;
		painter.fillRect((width - size) / 2, y + size * breath + 26, size * progress, 2);
		if (!lines.length) centerText('暂无歌词，安心听歌', y + size * breath + 65, 16, .5);
	}

	function draw() {
		surface?.paint(paint);
	}

	function paint() {
		if (destroyed) return;
		canvas = surface!.canvas;
		painter = surface!.painter!;
		options = getOptions();
		position = Math.max(0, options.audio?.currentTime !== undefined ? options.audio.currentTime * 1000 : options.currentTimeMs);
		motion = motionFactor(options.intensity, reduce.matches);
		if (cachedLyrics !== options.lyrics || cachedLanguage !== options.language) {
			cachedLyrics = options.lyrics;
			cachedLanguage = options.language;
			lines = prepareStageLyrics(options.lyrics, options.language);
			lyricFamily = lines.some((line) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line.text)) ? japaneseFamily : family;
			textWidths.clear();
		}
		if (coverUrl !== options.coverUrl) {
			coverUrl = options.coverUrl;
			cover = undefined;
			if (coverUrl) {
				const image = new Image();
				image.onload = () => {
					if (destroyed || cover !== image) return;
					try {
						const sample = document.createElement('canvas');
						sample.width = sample.height = 12;
						const sampler = sample.getContext('2d');
						if (sampler) {
							sampler.drawImage(image, 0, 0, 12, 12);
							const pixels = sampler.getImageData(0, 0, 12, 12).data;
							const color = [0, 0, 0];
							for (let index = 0; index < pixels.length; index += 4) {
								for (let channel = 0; channel < 3; channel++) color[channel] += pixels[index + channel] / (pixels.length / 4);
							}
							accent = `rgb(${color.map((value) => Math.round(lerp(value, 255, .45))).join(',')})`;
						}
					} catch {}
					render();
				};
				image.src = coverUrl;
				cover = image;
			}
		}
		const bounds = canvas.getBoundingClientRect();
		width = Math.max(1, bounds.width);
		height = Math.max(1, bounds.height);
		const ratio = Math.min(2, devicePixelRatio || 1);
		if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
		}
		painter.setTransform(ratio, 0, 0, ratio, 0, 0);
		painter.clearRect(0, 0, width, height);
		const state = stageSnapshot(lines, position, options.durationMs, options.hotComments, options.showHotComments);
		const levels = options.getLevels();
		if (state.comment) {
			const size = Math.min(34, Math.max(18, width * .035), height * .09);
			const rows = Math.max(1, Math.min(6, Math.floor(height * .42 / (size * 1.5))));
			centerText('热评', height * .17, 12, .5, 700);
			centerText(state.comment.text, height * .30, size, .92, 600, Math.min(760, width * .8), rows);
			centerText(`${state.comment.author} · ${state.comment.likes.toLocaleString()} 人喜欢`, height * .85, 13, .55);
		} else if (state.interlude) interlude(state.interlude.progress, levels);
		else {
			const size = Math.min(64, Math.max(28, width * .045));
			const drawLine = (line: StageLine, fade: number) => {
				if (options.style === 'partita') partita(line, size, fade);
				else if (options.style === 'tilt') tilt(line, fade);
				else if (options.style === 'spotlight' || options.style === 'wave') focus(line, size, fade, levels);
				else flow(line, size, fade);
			};
			if (state.previous) drawLine(state.previous, state.previousOpacity);
			if (state.current) drawLine(state.current, 1);
		}
		if (!state.comment) {
			if (state.current?.translation && !state.interlude) centerText(state.current.translation, height - 65, width < 500 ? 14 : 18, .72);
			if (state.next) centerText(state.next.text, height - 24, width < 500 ? 12 : 14, .32, 400, width * .85, 1);
		}
	}

	function tick(timestamp: number) {
		if (destroyed || document.hidden) return;
		if (timestamp - lastFrame >= 1000 / 40) {
			draw();
			lastFrame = timestamp;
		}
		animation = requestAnimationFrame(tick);
	}

	function reducedTick() {
		if (destroyed || document.hidden) return;
		draw();
		if (!getOptions().playing) return;
		const next = lines.flatMap((line) => [line.atMs, line.endMs, ...line.words.flatMap((word) => [word.startMs, word.endMs])])
			.filter((boundary) => boundary > position + 1).sort((first, second) => first - second)[0];
		boundaryTimer = setTimeout(reducedTick, Math.max(20, Math.min(1000, (next ?? position + 1000) - position + 20)));
	}

	function render() {
		cancel();
		if (destroyed || document.hidden) return;
		draw();
		if (getOptions().playing) {
			if (reduce.matches) reducedTick();
			else animation = requestAnimationFrame(tick);
		}
	}

	const observer = new ResizeObserver(render);
	observer.observe(canvas.parentElement ?? canvas);
	document.addEventListener('visibilitychange', render);
	reduce.addEventListener('change', render);
	return {
		render,
		destroy() {
			destroyed = true;
			cancel();
			observer.disconnect();
			document.removeEventListener('visibilitychange', render);
			reduce.removeEventListener('change', render);
			if (cover) cover.onload = null;
			textWidths.clear();
			surface.destroy();
		}
	};
}
