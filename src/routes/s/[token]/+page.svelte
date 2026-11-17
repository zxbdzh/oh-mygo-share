<script lang="ts">
	import Player from '../../../lib/components/Player.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.share ? `${data.share.title} · Oh MyGo Share` : 'Oh MyGo Share'}</title>
	<meta
		name="description"
		content={data.share ? `${data.share.title} by ${data.share.artists}` : 'Shared listening page'}
	/>
</svelte:head>

{#if data.error}
	<main class="error-page">
		<div>
			<p class="eyebrow">Oh MyGo Share</p>
			<h1>分享不可用</h1>
			<p>此链接已过期、被撤销，或无法播放。</p>
		</div>
	</main>
{:else if data.share}
	<Player share={data.share} token={data.share.token} />
{:else}
	<main class="loading-page"><p>正在准备分享…</p></main>
{/if}

<style>
	:global(body) {
		margin: 0;
	}

	.error-page,
	.loading-page {
		align-items: center;
		background: #101116;
		box-sizing: border-box;
		color: #f4f3f0;
		display: flex;
		min-height: 100svh;
		padding: 2rem;
	}

	.error-page > div {
		margin: 0 auto;
		max-width: 32rem;
	}

	.eyebrow {
		color: #e98ab8;
		font-size: 0.72rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	h1 {
		font-size: clamp(2.2rem, 6vw, 4.5rem);
		letter-spacing: -0.05em;
		margin: 0.5rem 0;
	}

	.error-page p:last-child,
	.loading-page p {
		color: #b5b3bd;
		line-height: 1.6;
	}
</style>
