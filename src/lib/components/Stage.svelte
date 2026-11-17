<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { createStageRenderer, type StageRendererOptions } from '../stage-renderer';
	import { prepareStageLyrics } from '../stage';

	let props: StageRendererOptions = $props();
	let canvas = $state<HTMLCanvasElement | null>(null);
	let renderer: ReturnType<typeof createStageRenderer> | undefined;
	const shownLyrics = $derived(prepareStageLyrics(props.lyrics, props.language));
	const currentLine = $derived(shownLyrics.filter((line) => line.atMs <= props.currentTimeMs).at(-1));

	onMount(() => {
		if (!canvas) return;
		renderer = createStageRenderer(canvas, () => props);
		renderer.render();
		return () => { renderer?.destroy(); renderer = undefined; };
	});

	$effect(() => {
		const { currentTimeMs, playing, style, intensity, language, sparks, showHotComments, audio } = props;
		void [currentTimeMs, playing, style, intensity, language, sparks, showHotComments, audio];
		untrack(() => renderer?.render());
	});
</script>

<div class="stage-canvas" role="img" aria-label={`律动歌词：${currentLine?.text ?? '间奏'}`}>
	<canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>
<div class="sr-only">
	{currentLine?.text ?? '暂无歌词'}
	{#if props.language === 'bilingual' && currentLine?.translation}{currentLine.translation}{/if}
</div>

<style>
	.stage-canvas { width: 100%; height: 100%; }
	canvas { width: 100%; height: 100%; display: block; background: transparent; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); border: 0; }
</style>
