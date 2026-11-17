<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Lyrics from './Lyrics.svelte';
	import Stage from './Stage.svelte';
	import { createAudioSpectrum } from '../stage-audio';
	import {
		stageIntensities, stageLanguages, stagePreferences, stageStyles,
		type StageIntensity, type StageLanguage, type StageStyle
	} from '../stage';
	import type { Session, ShareMetadata } from '../types';

	type Props = {
		share: ShareMetadata;
		token: string;
	};

	let { share, token }: Props = $props();
	let audio = $state<HTMLAudioElement | null>(null);
	let sessionId = $state<string | null>(null);
	let audioUrl = $state('');
	let playing = $state(false);
	let currentTimeMs = $state(0);
	let durationMs = $state(0);
	let volume = $state(0.85);
	let busy = $state(false);
	let errorMessage = $state('');
	let displayMode = $state<'lyrics' | 'stage'>('lyrics');
	let stageStyle = $state<StageStyle>('flow');
	let stageIntensity = $state<StageIntensity>('standard');
	let stageLanguage = $state<StageLanguage>('bilingual');
	let stageSparks = $state(false);
	let stageHotComments = $state(true);
	let preferencesLoaded = $state(false);
	let spectrum: ReturnType<typeof createAudioSpectrum> | undefined;
	const getLevels = () => spectrum?.levels() ?? null;
	let activityInterval: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		durationMs = share.durationMs;
		try {
			const saved = stagePreferences(JSON.parse(localStorage.getItem('oh-mygo-share:stage:v1') ?? '{}'));
			stageStyle = saved.style;
			stageIntensity = saved.intensity;
			stageLanguage = saved.language;
			stageSparks = saved.sparks;
			stageHotComments = saved.hotComments;
		} catch {
			// 禁用存储或旧数据损坏时仍可正常收听，只是不记住显示偏好。
		}
		preferencesLoaded = true;
		void fetch(`/api/public/${token}/open`, { method: 'POST' })
			.then((response) => {
				if (!response.ok) errorMessage = response.status === 410 ? '分享已过期或被撤销。' : '未能更新有效期，播放时将重新检查。';
			})
			.catch(() => { errorMessage = '网络暂不可用，请检查连接后重试。'; });
		return () => closeSession();
	});

	onDestroy(() => { closeSession(); spectrum?.destroy(); });

	$effect(() => {
		if (!preferencesLoaded) return;
		const saved = { style: stageStyle, intensity: stageIntensity, language: stageLanguage, sparks: stageSparks, hotComments: stageHotComments };
		try { localStorage.setItem('oh-mygo-share:stage:v1', JSON.stringify(saved)); } catch {}
	});

	async function ensureSession(): Promise<boolean> {
		if (sessionId && audioUrl) return true;
		busy = true;
		errorMessage = '';
		try {
			const response = await fetch(`/api/public/${token}/sessions`, { method: 'POST' });
			if (!response.ok) throw new Error('分享已不可用，请联系分享者重新生成链接。');
			const result = (await response.json()) as Session;
			sessionId = result.sessionId;
			audioUrl = result.audioUrl;
			if (audio) audio.src = result.audioUrl;
			return true;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : '无法准备音频。';
			return false;
		} finally {
			busy = false;
		}
	}

	async function togglePlayback() {
		if (!audio || busy) return;
		if (playing) {
			audio.pause();
			return;
		}
		spectrum ??= createAudioSpectrum(audio);
		const preparingSpectrum = spectrum.prepare();
		if (!(await ensureSession())) return;
		// 恢复前由服务端核验，不能依靠浏览器已缓冲的音频绕过暂停到期。
		if (!(await sendActivity(true))) return;
		try {
			await preparingSpectrum;
			await audio.play();
		} catch {
			errorMessage = '播放被阻塞，请点击播放重试。';
		}
	}

	async function sendActivity(isPlaying: boolean): Promise<boolean> {
		const id = sessionId;
		if (!id) return false;
		try {
		const response = await fetch(`/api/public/${token}/sessions/${id}/activity`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ playing: isPlaying })
		});
			if (sessionId !== id) return false;
			if ([401, 404, 410].includes(response.status)) {
				audio?.pause();
				closeSession();
				errorMessage = '本次收听已结束，请再次点击播放；失效链接需重新分享。';
				return false;
			}
			if (!response.ok) throw new Error('activity_failed');
			return true;
		} catch {
			errorMessage = '无法连接分享服务，请检查网络后重试。';
			return false;
		}
	}

	function startActivity() {
		stopActivity();
		void sendActivity(true);
		activityInterval = setInterval(() => {
			if (playing && audio && !audio.paused && !audio.ended && audio.readyState >= 3) void sendActivity(true);
		}, 30_000);
	}

	function stopActivity() {
		if (activityInterval) clearInterval(activityInterval);
		activityInterval = undefined;
	}

	function onPlay() {
		playing = true;
		errorMessage = '';
		startActivity();
	}

	function onPause() {
		if (!playing) return;
		playing = false;
		stopActivity();
		sendActivity(false);
	}

	function onEnded() {
		playing = false;
		stopActivity();
		sendActivity(false);
		closeSession();
	}

	function closeSession() {
		stopActivity();
		const id = sessionId;
		sessionId = null;
		audioUrl = '';
		playing = false;
		if (id) {
			void fetch(`/api/public/${token}/sessions/${id}/close`, { method: 'POST' }).catch(
				() => undefined
			);
		}
	}

	function updateTime() {
		if (audio) currentTimeMs = audio.currentTime * 1000;
	}

	function updateDuration() {
		if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
			durationMs = audio.duration * 1000;
		}
	}

	function seek(event: Event) {
		if (audio) audio.currentTime = Number((event.currentTarget as HTMLInputElement).value) / 1000;
	}

	function setVolume(event: Event) {
		volume = Number((event.currentTarget as HTMLInputElement).value);
		if (audio) audio.volume = volume;
	}

	function formatTime(milliseconds: number): string {
		const seconds = Math.max(0, Math.floor(milliseconds / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	}
</script>

<div class="player-shell" class:stage-mode={displayMode === 'stage'} data-theme={share.template}>
	<div
		class="ambient"
		style:background-image={share.coverUrl ? `url("${share.coverUrl}")` : undefined}
	></div>

	<header class="stage-toolbar">
		<nav class="display-tabs" aria-label="播放视图">
			<button type="button" aria-pressed={displayMode === 'lyrics'} onclick={() => (displayMode = 'lyrics')}>歌词</button>
			<button type="button" aria-pressed={displayMode === 'stage'} onclick={() => (displayMode = 'stage')}>律动</button>
		</nav>
		{#if displayMode === 'stage'}
			<div class="stage-settings" aria-label="律动设置">
				<select aria-label="律动效果" bind:value={stageStyle}>
					{#each stageStyles as option}<option value={option.value}>{option.label}</option>{/each}
				</select>
				<select aria-label="动效强度" bind:value={stageIntensity}>
					{#each stageIntensities as option}<option value={option.value}>{option.label}</option>{/each}
				</select>
				<select aria-label="律动语言" bind:value={stageLanguage}>
					{#each stageLanguages as option}<option value={option.value}>{option.label}</option>{/each}
				</select>
				<button type="button" class="setting-toggle" aria-label="火花" aria-pressed={stageSparks} onclick={() => (stageSparks = !stageSparks)}>火花</button>
				{#if share.hotComments?.length}
					<button type="button" class="setting-toggle" aria-label="间奏热评" aria-pressed={stageHotComments} onclick={() => (stageHotComments = !stageHotComments)}>热评</button>
				{/if}
			</div>
			<div class="stage-source">
				<span>{share.mode === 'clip' ? '歌词片段' : '整首分享'}</span>
				{#if share.sourceUrl}<a href={share.sourceUrl} target="_blank" rel="noreferrer">原曲</a>{/if}
			</div>
		{/if}
	</header>

	<main class="stage">
		<section class="identity" aria-label="正在播放">
			<div class="cover-frame">
				{#if share.coverUrl}
					<img src={share.coverUrl} alt={`${share.title}的封面`} />
				{:else}
					<div class="cover-placeholder" aria-label="暂无封面">
						<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<ellipse cx="7" cy="17" rx="3" ry="2.5" />
							<ellipse cx="18" cy="15" rx="3" ry="2.5" />
							<path d="M10 17V5l11-2v12M10 8l11-2" stroke-linejoin="round" />
						</svg>
					</div>
				{/if}
			</div>

			<div class="song-info">
				<h1 title={share.title}>{share.title}</h1>
				<p class="artists" title={share.artists}>{share.artists}</p>
				<div class="share-info">
					<span>{share.mode === 'clip' ? '歌词片段' : '整首分享'}</span>
					{#if share.sourceUrl}
						<a href={share.sourceUrl} target="_blank" rel="noreferrer">查看歌曲原页</a>
					{/if}
				</div>
			</div>

			<div class="controls">
				<div class="timeline">
					<input
						aria-label="播放进度"
						type="range"
						min="0"
						max={durationMs}
						step="10"
						value={currentTimeMs}
						style:--fill={`${durationMs > 0 ? Math.min(100, currentTimeMs / durationMs * 100) : 0}%`}
						oninput={seek}
					/>
					<div class="time-row">
						<span>{formatTime(currentTimeMs)}</span>
						<span>-{formatTime(durationMs - currentTimeMs)}</span>
					</div>
				</div>

				<div class="transport">
					<button
						class="play-button"
						type="button"
						onclick={togglePlayback}
						aria-label={playing ? '暂停' : '播放'}
						aria-busy={busy}
						disabled={busy}
					>
						{#if playing}
							<svg viewBox="0 0 24 24" width="35" height="35" fill="currentColor" aria-hidden="true">
								<rect x="5" y="3" width="5" height="18" rx="1.5" />
								<rect x="14" y="3" width="5" height="18" rx="1.5" />
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" width="35" height="35" fill="currentColor" aria-hidden="true">
								<path d="M6.5 3.8c0-.8.9-1.3 1.6-.9l13 8.2a1 1 0 0 1 0 1.8l-13 8.2c-.7.4-1.6-.1-1.6-.9V3.8Z" />
							</svg>
						{/if}
						<span class="sr-only">{busy ? '准备中' : playing ? '暂停' : '播放'}</span>
					</button>
				</div>

				<label class="volume-control">
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
						<path d="M11 5 6 9H3v6h3l5 4V5Z" stroke-linejoin="round" />
						<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" stroke-linecap="round" />
					</svg>
					<span class="sr-only">音量</span>
					<input
						aria-label="音量"
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={volume}
						style:--fill={`${volume * 100}%`}
						oninput={setVolume}
					/>
				</label>
				{#if errorMessage}
					<p class="error" role="alert">{errorMessage}</p>
				{/if}
			</div>
		</section>

		{#if displayMode === 'stage'}
			<section class="rhythm-stage" aria-label="律动">
				<Stage lyrics={share.lyrics} {currentTimeMs} {durationMs} {playing} {audio}
					coverUrl={share.coverUrl} title={share.title} style={stageStyle} intensity={stageIntensity}
					sparks={stageSparks} language={stageLanguage} hotComments={share.hotComments}
					showHotComments={stageHotComments} {getLevels} />
			</section>
		{:else}
			<section class="lyrics-stage" aria-label="分享歌词">
				<Lyrics lyrics={share.lyrics} {currentTimeMs} />
			</section>
		{/if}
	</main>

	<audio
		bind:this={audio}
		bind:volume
		preload="none"
		onplay={onPlay}
		onpause={onPause}
		onended={onEnded}
		ontimeupdate={updateTime}
		onloadedmetadata={updateDuration}
		onerror={() => (errorMessage = '音频加载失败。')}
	></audio>
</div>

<style>
	.player-shell {
		--ink: #fff;
		--muted: rgb(255 255 255 / 60%);
		--accent: #fff;
		--cover-size: clamp(180px, calc(100svh - 492px), 440px);
		position: relative;
		isolation: isolate;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		height: 100svh;
		width: 100%;
		overflow: hidden;
		box-sizing: border-box;
		background: #0b0b0d;
		color: var(--ink);
		font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
		line-height: 1.5;
	}

	.ambient {
		position: absolute;
		inset: -15%;
		pointer-events: none;
		background-size: cover;
		background-position: center;
		filter: blur(80px) brightness(0.55) saturate(1.35);
		opacity: 0.65;
		animation: drift 24s ease-in-out infinite alternate;
	}

	.ambient::after {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, rgb(11 11 13 / 8%), rgb(11 11 13 / 50%));
	}

	.stage-toolbar {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 24px;
		min-height: 56px;
		padding: 0 max(72px, calc((100% - 1280px) / 2));
		color: #fff;
		box-sizing: border-box;
	}

	.display-tabs, .stage-settings, .stage-source {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.display-tabs button, .setting-toggle, .stage-settings select {
		min-height: 44px;
		border: 0;
		border-radius: 999px;
		padding: 6px 14px;
		background: transparent;
		color: rgb(255 255 255 / 55%);
		font: 600 13px 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
		cursor: pointer;
	}

	.display-tabs button[aria-pressed='true'], .setting-toggle[aria-pressed='true'] {
		background: rgb(255 255 255 / 14%);
		color: #fff;
	}

	.stage-settings select { padding-inline: 10px; color-scheme: dark; }
	.stage-settings option { background: #17151c; color: #fff; }
	.stage-settings select:focus-visible { outline: 2px solid rgb(255 255 255 / 85%); }
	.stage-settings { flex-wrap: wrap; gap: 0 4px; }
	.stage-source { margin-left: auto; gap: 14px; color: rgb(255 255 255 / 45%); font-size: 11px; }
	.stage-source a { display: inline-flex; align-items: center; min-height: 44px; color: inherit; text-underline-offset: 4px; }

	.stage {
		position: relative;
		display: grid;
		grid-template-columns: max(280px, var(--cover-size)) minmax(0, 1fr);
		gap: 72px;
		width: 100%;
		max-width: 1424px;
		height: 100%;
		margin: 0 auto;
		padding: 72px 72px 44px;
		box-sizing: border-box;
		align-items: center;
	}

	.identity {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.cover-frame {
		width: var(--cover-size);
		max-width: 100%;
		aspect-ratio: 1;
		flex-shrink: 0;
		border-radius: 16px;
		overflow: hidden;
		background: rgb(255 255 255 / 6%);
		box-shadow: 0 14px 40px rgb(0 0 0 / 25%);
	}

	.cover-frame img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.cover-placeholder {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
		color: rgb(255 255 255 / 25%);
	}

	.song-info {
		margin-top: 36px;
		min-width: 0;
	}

	h1 {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 22px;
		font-weight: 700;
		line-height: 1.35;
		letter-spacing: -0.3px;
	}

	.artists {
		margin: 4px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 15px;
		color: var(--muted);
	}

	.share-info {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0 14px;
		min-height: 32px;
		color: rgb(255 255 255 / 45%);
		font-size: 11px;
	}

	.share-info a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: inherit;
		text-decoration-color: rgb(255 255 255 / 25%);
		text-underline-offset: 4px;
	}

	.share-info a:hover {
		color: #fff;
	}

	.controls {
		min-width: 0;
	}

	.time-row {
		display: flex;
		justify-content: space-between;
		margin-top: -8px;
		color: rgb(255 255 255 / 50%);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.transport {
		display: flex;
		justify-content: center;
		margin: 14px 0 10px;
	}

	.play-button {
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border: 0;
		border-radius: 12px;
		padding: 0;
		background: none;
		color: #fff;
		cursor: pointer;
		transition: transform 120ms ease, opacity 120ms ease;
	}

	.play-button:hover {
		opacity: 0.8;
	}

	.play-button:active {
		transform: scale(0.94);
	}

	.play-button:disabled {
		cursor: wait;
		opacity: 0.45;
	}

	.volume-control {
		display: flex;
		align-items: center;
		gap: 8px;
		width: min(208px, 100%);
		margin: 0 auto;
		color: rgb(255 255 255 / 70%);
	}

	.volume-control svg {
		flex-shrink: 0;
	}

	input[type='range'] {
		--fill: 0%;
		display: block;
		appearance: none;
		width: 100%;
		min-width: 0;
		height: 44px;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	input[type='range']::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(to right, rgb(255 255 255 / 90%) var(--fill), rgb(255 255 255 / 18%) var(--fill));
	}

	input[type='range']::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(to right, rgb(255 255 255 / 90%) var(--fill), rgb(255 255 255 / 18%) var(--fill));
	}

	input[type='range']::-webkit-slider-thumb {
		appearance: none;
		width: 10px;
		height: 10px;
		margin-top: -3px;
		border: 0;
		border-radius: 50%;
		background: #fff;
	}

	input[type='range']::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 0;
		border-radius: 50%;
		background: #fff;
	}

	.lyrics-stage {
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		padding-top: 24px;
		box-sizing: border-box;
	}

	.rhythm-stage { grid-row: 1; height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
	.stage-mode .stage {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr) auto;
		gap: 12px;
		padding: 0 48px 24px;
		max-width: none;
	}
	.stage-mode .identity {
		display: grid;
		grid-row: 2;
		grid-template-columns: 44px minmax(0, 1fr) 56px minmax(120px, 208px);
		align-items: center;
		gap: 0 14px;
	}
	.stage-mode .controls { display: contents; }
	.stage-mode .timeline { grid-row: 1; grid-column: 1 / -1; }
	.stage-mode .time-row { margin-top: -10px; margin-bottom: 8px; }
	.stage-mode .cover-frame { width: 44px; grid-row: 2; grid-column: 1; border-radius: 8px; }
	.stage-mode .song-info { grid-row: 2; grid-column: 2; margin: 0; }
	.stage-mode h1 { font-size: 14px; }
	.stage-mode .artists { font-size: 12px; margin-top: 2px; }
	.stage-mode .share-info { display: none; }
	.stage-mode .transport { grid-row: 2; grid-column: 3; margin: 0; }
	.stage-mode .volume-control { grid-row: 2; grid-column: 4; width: 100%; }
	.stage-mode .error { grid-row: 3; grid-column: 1 / -1; }

	.error {
		margin: 8px 0 0;
		color: #efb3ab;
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	button:focus-visible,
	a:focus-visible,
	input:focus-visible {
		outline: 2px solid rgb(255 255 255 / 85%);
		outline-offset: 4px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		clip-path: inset(50%);
		overflow: hidden;
		white-space: nowrap;
	}

	@keyframes drift {
		from { transform: translate(-2%, -1%) scale(1); }
		to { transform: translate(3%, 2%) scale(1.08); }
	}

	@media (min-width: 761px) and (max-width: 1050px) {
		.player-shell { --cover-size: clamp(180px, calc(100svh - 436px), 32vw); }
		.stage { gap: 40px; padding-inline: 40px; }
	}

	@media (max-width: 760px) {
		.stage-toolbar { padding: max(4px, env(safe-area-inset-top)) 20px 4px; gap: 0 8px; }
		.stage-settings { order: 3; width: 100%; gap: 0 2px; }
		.stage-settings select { padding-inline: 8px; }
		.stage-settings .setting-toggle { padding-inline: 10px; }
		.stage-source { font-size: 10px; }
		.stage {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: max-content minmax(0, 1fr);
			gap: 16px;
			padding: max(20px, env(safe-area-inset-top)) 20px max(16px, env(safe-area-inset-bottom));
		}

		.identity {
			display: grid;
			grid-template-columns: clamp(112px, 30vw, 140px) minmax(0, 1fr);
			align-items: center;
			gap: 12px 16px;
		}

		.cover-frame {
			width: 100%;
			border-radius: 12px;
		}

		.song-info {
			margin: 0;
		}

		h1 {
			font-size: 20px;
			white-space: normal;
			overflow-wrap: anywhere;
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
		}

		.artists { font-size: 13px; }
		.share-info { gap: 0 8px; font-size: 10px; }

		.controls {
			display: grid;
			grid-column: 1 / -1;
			grid-template-columns: 56px minmax(0, 1fr);
			align-items: center;
			gap: 4px 20px;
		}

		.timeline { grid-column: 1 / -1; }
		.transport { margin: 0; }
		.volume-control { justify-self: end; margin: 0; }
		.error { grid-column: 1 / -1; margin: 4px 0; }
		.lyrics-stage { padding-top: 0; }
		.stage-mode .stage { padding: 0 20px max(16px, env(safe-area-inset-bottom)); gap: 6px; }
		.stage-mode .identity { grid-template-columns: 44px minmax(0, 1fr) 56px; gap: 0 12px; }
		.stage-mode .volume-control { grid-row: 3; grid-column: 2 / -1; width: min(208px, 100%); }
		.stage-mode .error { grid-row: 4; }
		.stage-mode h1 { display: block; white-space: nowrap; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ambient { animation: none; }
		.play-button { transition: none; }
	}
</style>
