<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Lyrics from './Lyrics.svelte';
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
	let activityInterval: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		durationMs = share.durationMs;
		void fetch(`/api/public/${token}/open`, { method: 'POST' })
			.then((response) => {
				if (!response.ok) errorMessage = response.status === 410 ? '分享已过期或被撤销。' : '未能更新有效期，播放时将重新检查。';
			})
			.catch(() => { errorMessage = '网络暂不可用，请检查连接后重试。'; });
		return () => closeSession();
	});

	onDestroy(() => closeSession());

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
		if (!(await ensureSession())) return;
		// 恢复前由服务端核验，不能依靠浏览器已缓冲的音频绕过暂停到期。
		if (!(await sendActivity(true))) return;
		try {
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

<div
	class="player-shell"
	data-theme={share.template}
>
	<div
		class="ambient"
		style:background-image={share.coverUrl ? `url("${share.coverUrl}")` : undefined}
	></div>
	<main class="stage">
		<section class="identity">
			<div class="cover-frame" class:playing={playing}>
				{#if share.coverUrl}
					<img src={share.coverUrl} alt={`${share.title} cover`} />
				{:else}
					<div class="cover-placeholder" aria-hidden="true"></div>
				{/if}
			</div>
			<div class="song-info">
				<p class="mode">{share.mode === 'clip' ? '歌词片段' : '整首分享'}</p>
				<h1>{share.title}</h1>
				<p class="artists">{share.artists}</p>
				{#if share.sourceUrl}
					<a href={share.sourceUrl} target="_blank" rel="noreferrer">查看歌曲原页 ↗</a>
				{/if}
			</div>
		</section>

		<section class="lyrics-stage" aria-label="Shared lyrics">
			<Lyrics lyrics={share.lyrics} {currentTimeMs} />
		</section>
	</main>

	<footer class="controls">
		<audio
			bind:this={audio}
			bind:volume
			onplay={onPlay}
			onpause={onPause}
			onended={onEnded}
			ontimeupdate={updateTime}
			onloadedmetadata={updateDuration}
			onerror={() => (errorMessage = '音频加载失败。')}
		></audio>
		<div class="control-row">
			<button
				class="play-button"
				class:loading={busy}
				type="button"
				onclick={togglePlayback}
				aria-label={playing ? '暂停' : '播放'}
				disabled={busy}
			>
				{#if playing}
					<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
				{:else}
					<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
				{/if}
				<span class="sr-only">{busy ? '准备中' : playing ? '暂停' : '播放'}</span>
			</button>
			<div class="timeline">
				<div class="time-row">
					<span>{formatTime(currentTimeMs)}</span>
					<span>{formatTime(durationMs)}</span>
				</div>
				<input
					aria-label="播放进度"
					type="range"
					min="0"
					max={durationMs}
					step="10"
					value={currentTimeMs}
					oninput={seek}
				/>
			</div>
			<label class="volume-control">
				<span class="sr-only">音量</span>
				<input
					aria-label="音量"
					type="range"
					min="0"
					max="1"
					step="0.01"
					bind:value={volume}
					oninput={setVolume}
				/>
			</label>
		</div>
		{#if errorMessage}
			<p class="error" role="alert">{errorMessage}</p>
		{/if}
	</footer>
</div>

<style>
.player-shell {
    position: relative;
    isolation: isolate;
    min-height: 100svh;
    overflow: hidden;
    display: block;
    font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', sans-serif;
    line-height: 1.5;
    background: #101116;
    color: var(--ink);
    --ink: #f4f1ee;
    --muted: #b7b4bd;
    --accent: #eabf9a;
}

.ambient {
    position: absolute;
    inset: -12%;
    z-index: -1;
    background-size: cover;
    background-position: center;
    filter: blur(80px) brightness(0.62) saturate(1.2);
    opacity: 0.6;
    pointer-events: none;
}

.ambient::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(120deg,rgba(12,14,18,.3),rgba(12,14,18,.65));
}

.stage {
    position: relative;
    width: min(1120px, 100%);
    margin: auto;
    height: calc(100svh - 130px);
    min-height: 500px;
    padding: 50px 52px 20px;
    display: grid;
    grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
    gap: clamp(48px, 7vw, 110px);
    align-items: center;
    box-sizing: border-box;
    z-index: 1;
}

.identity {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 24px;
    min-width: 0;
}

.cover-frame {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    max-width: 340px;
    aspect-ratio: 1;
    flex-shrink: 0;
    border-radius: 18px;
    overflow: hidden;
    outline: 1px solid rgba(255,255,255,0.1);
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
}

.cover-frame img {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
}

.song-info {
    color: var(--ink);
}

.mode { margin: 0 0 10px; color: var(--accent); font-size: 11px; letter-spacing: 0.12em; }
.song-info a { display: inline-block; margin-top: 14px; color: var(--muted); font-size: 12px; text-underline-offset: 4px; }
.cover-placeholder { width: 100%; height: 100%; background: repeating-radial-gradient(circle at 50% 50%, #252933 0 2px, #171a22 3px 5px); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; }

.song-info h1 {
    font-size: clamp(24px, 2.3vw, 34px);
    line-height: 1.3;
    margin: 0;
    text-wrap: balance;
    word-break: normal;
    overflow-wrap: anywhere;
}

.artists {
    color: var(--muted);
    font-size: 14px;
    margin: 8px 0 0;
}

.lyrics-stage {
    height: min(62svh, 560px);
    min-height: 0;
    mask-image: linear-gradient(transparent, #000 12%, #000 88%, transparent);
}

.controls {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    width: min(980px, calc(100% - 48px));
    box-sizing: border-box;
    padding: 18px 24px;
    border-radius: 20px;
    backdrop-filter: blur(24px);
    background: rgba(28, 27, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    z-index: 2;
}

.control-row {
    display: flex;
    align-items: center;
    gap: 20px;
}

.play-button {
    flex: 0 0 48px;
    width: 48px;
    height: 48px;
    padding: 0;
    cursor: pointer;
    border-radius: 50%;
    background: var(--accent);
    border: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #000;
    transition: transform 0.1s;
}
.play-button:hover { transform: translateY(-1px); }
.play-button:active { transform: scale(0.96); }
.play-button svg { flex-shrink: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }

.timeline {
    flex: 1;
    min-width: 0;
}

.time-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    margin-bottom: 9px;
}

.volume-control {
    flex: 0 0 100px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
}
.volume-control input { flex: 1; min-width: 0; }
.error { margin: 12px 0 0; color: #efb3ab; font-size: 12px; }

input[type=range] {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    height: 4px;
    appearance: none;
    border: 0;
    border-radius: 999px;
    background: rgba(210, 208, 217, 0.28);
    accent-color: var(--accent);
    cursor: pointer;
}
input[type=range]::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    border: 0;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
}
input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: var(--accent); }

/* Themes */
[data-theme='minimal'] { --ink: #f4f1ee; --muted: #b7b4bd; --accent: #eabf9a; background: #101116; }
.player-shell[data-theme='minimal'] { background: #101116; }
[data-theme='minimal'] .cover-frame { border-radius: 12px; }

[data-theme='cinema'] { --ink: #f4f1ee; --muted: #aaa8ad; --accent: #eabf9a; }

[data-theme='vinyl'] .cover-frame { border-radius: 50%; }

.player-shell[data-theme='polaroid'] { background: #efeeea; --ink: #25262a; --muted: #74767c; --accent: #956849; }
[data-theme='polaroid'] .ambient { opacity: 0.13; }
[data-theme='polaroid'] .cover-frame { border: 14px solid #fff; border-bottom-width: 42px; border-radius: 0; }
[data-theme='polaroid'] .ambient::after { background: rgba(250,248,243,0.86); }
[data-theme='polaroid'] .controls { background: rgba(250,248,243,0.86); border: 1px solid rgba(0,0,0,0.09); }

[data-theme='vinyl'] .cover-frame { animation: spin 20s linear infinite; animation-play-state: paused; }
[data-theme='vinyl'] .cover-frame.playing { animation-play-state: running; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
[data-theme=vinyl] .cover-frame { background: repeating-radial-gradient(circle,#151518 0px,#151518 2px,#232329 3px,#151518 4px); padding: 18%; box-sizing: border-box; }
[data-theme=vinyl] .cover-frame img { border-radius: 50%; }
[data-theme='vinyl'] .cover-frame::after { content: ''; position: absolute; width: 8px; height: 8px; border: 3px solid #17191d; border-radius: 50%; background: #d9d4cb; top: 50%; left: 50%; transform: translate(-50%, -50%); }
[data-theme='cinema'] .cover-frame { border-radius: 8px; }

[data-theme='ticket'] .identity { border: 1px dashed rgba(255,255,255,0.3); padding: 24px; border-radius: 8px; }

/* Mobile */
@media (max-width: 760px) {
    .stage {
        display: flex;
        flex-direction: column;
        padding: 28px 24px 120px;
        height: 100svh;
        min-height: 620px;
        gap: 24px;
    }
    .identity { align-items: center; gap: 16px; text-align: center; }
    .cover-frame { width: min(50vw, 200px); max-width: 200px; }
    .song-info h1 { font-size: 22px; margin: 0; }
    .lyrics-stage { width: 100%; flex: 1; min-height: 100px; }
    .controls { bottom: 12px; padding: 14px 16px; width: calc(100% - 24px); }
    .control-row { gap: 14px; }
    .play-button { width: 44px; height: 44px; flex-basis: 44px; }
    .volume-control { flex: 0 0 68px; }
    .volume-control input { width: 48px; }
.stage { padding: 28px 24px 120px; height: 100svh; min-height: 0; box-sizing: border-box; overflow: hidden; }
    .identity { width: 100%; }
    .song-info { width: 100%; max-width: 340px; }
    .lyrics-stage { min-height: 80px; overflow: hidden; }
}

@media (max-height: 650px) {
    .stage { padding-top: 20px; min-height: 0; gap: 18px; }
    .identity { gap: 12px; }
    .cover-frame { max-width: 200px; }
    .song-info h1 { font-size: 20px; }
    .lyrics-stage { height: 50svh; }
}
@media (max-width: 760px) and (max-height: 650px) {
    .cover-frame { width: 120px; }
    .song-info h1 { font-size: 18px; }
    .mode { margin-bottom: 5px; }
}
@media (prefers-reduced-motion: reduce) {
    [data-theme='vinyl'] .cover-frame { animation: none; }
    .play-button { transition: none; }
}
</style>
