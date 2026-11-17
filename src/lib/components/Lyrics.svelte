<script lang="ts">
	import type { ShareLyric } from '../types';

	type Props = {
		lyrics: ShareLyric[];
		currentTimeMs: number;
	};

	let { lyrics, currentTimeMs }: Props = $props();

	function active(line: ShareLyric): boolean {
		return currentTimeMs >= line.atMs && currentTimeMs < line.endMs;
	}

	let container = $state<HTMLElement | null>(null);
	let lineElements = $state<HTMLElement[]>([]);
	let lastActiveIndex = -1;

	$effect(() => {
		const activeIndex = lyrics.findIndex(
			(line) => currentTimeMs >= line.atMs && currentTimeMs < line.endMs
		);
		if (activeIndex !== lastActiveIndex && activeIndex !== -1 && lineElements[activeIndex] && container) {
			const line = lineElements[activeIndex];
			container.scrollTo({
				top: line.offsetTop - container.offsetTop - (container.clientHeight - line.clientHeight) / 2,
				behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
			});
			lastActiveIndex = activeIndex;
		}
	});
</script>

<section class="lyrics" aria-label="Lyrics" bind:this={container}>
	{#if lyrics.length === 0}
		<p class="empty">这次分享没有歌词，安心听歌吧。</p>
	{:else}
		{#each lyrics as line, i}
			<article
				class="line"
				class:active={active(line)}
				class:selected={line.selected}
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
    scrollbar-width: none;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 32px;
    padding: 35% 8px;
}

.line {
    position: relative;
    padding-left: 12px;
    opacity: 0.65;
    color: var(--muted, #b7b4bd);
    flex-shrink: 0;
}
.line.active { opacity: 1; color: var(--ink); }
.line.selected { opacity: 0.9; border-left: 2px solid var(--accent); }
.line.active.selected { opacity: 1; }
.text { font-size: 24px; font-weight: 600; line-height: 1.5; margin: 0; }
.translation { font-size: 13px; line-height: 1.6; opacity: 0.7; margin-top: 6px; }
.empty { color: var(--muted, #aaa8ad); margin: 0; }

@media (max-width: 760px) {
    .text { font-size: 19px; }
}
@media (prefers-reduced-motion: reduce) {
    .line { transition: none; }
}
</style>
