<script lang="ts">
	import type { ShareLyric } from '../types';

	type Props = {
		lyrics: ShareLyric[];
		currentTimeMs: number;
	};

	let { lyrics, currentTimeMs }: Props = $props();

	let container = $state<HTMLElement | null>(null);
	let lineElements = $state<HTMLElement[]>([]);
	const activeIndex = $derived(
		lyrics.findIndex((line) => currentTimeMs >= line.atMs && currentTimeMs < line.endMs)
	);
	let lastActiveIndex = -1;

	$effect(() => {
		if (activeIndex !== lastActiveIndex && activeIndex !== -1 && lineElements[activeIndex] && container) {
			const line = lineElements[activeIndex];
			// 只在换行时移动歌词容器，保留手动滚动，并与桌面版的三成定位一致。
			container.scrollTo({
				top: Math.max(0, line.offsetTop - container.clientHeight * 0.3),
				behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
			});
		}
		lastActiveIndex = activeIndex;
	});
</script>

<section class="lyrics" aria-label="歌词" bind:this={container}>
	{#if lyrics.length === 0}
		<p class="empty">这次分享没有歌词，安心听歌吧。</p>
	{:else}
		{#each lyrics as line, i}
			<article
				class="line"
				class:active={i === activeIndex}
				class:selected={line.selected}
				aria-current={i === activeIndex ? 'true' : undefined}
				bind:this={lineElements[i]}
			>
				<p class="text">{line.text}</p>
				{#if line.translation}
					<p class="translation">{line.translation}</p>
				{/if}
			</article>
		{/each}
	{/if}
</section>

<style>
	.lyrics {
		position: relative;
		box-sizing: border-box;
		height: 100%;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: none;
		padding: 0 8px 0 0;
	}

	.lyrics::after {
		content: '';
		display: block;
		height: 70%;
	}

	.line {
		position: relative;
		padding: 10px 12px;
		margin-bottom: 6px;
		border-radius: 12px;
		color: #fff;
		opacity: 0.28;
		transform: scale(0.94);
		transform-origin: left center;
		transition: opacity 380ms ease, transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.line:hover { opacity: 0.55; background: rgb(255 255 255 / 6%); }
	.line.active { opacity: 1; transform: scale(1); }
	.line.selected::before {
		content: '';
		position: absolute;
		left: 1px;
		top: 14px;
		bottom: 14px;
		width: 2px;
		border-radius: 2px;
		background: rgb(255 255 255 / 70%);
	}

	.text {
		margin: 0;
		font-size: 30px;
		font-weight: 800;
		line-height: 1.25;
		letter-spacing: -0.4px;
		overflow-wrap: anywhere;
	}

	.translation {
		margin: 6px 0 0;
		font-size: 17px;
		font-weight: 600;
		line-height: 1.5;
		color: rgb(255 255 255 / 70%);
		overflow-wrap: anywhere;
	}

	.empty {
		margin: 16px 12px;
		color: rgb(255 255 255 / 40%);
		font-size: 24px;
		font-weight: 700;
	}

	@media (max-width: 760px) {
		.text { font-size: 24px; }
		.translation { font-size: 14px; }
		.empty { font-size: 20px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.line { transition: none; }
	}
</style>
