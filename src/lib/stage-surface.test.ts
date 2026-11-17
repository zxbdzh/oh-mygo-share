import { describe, expect, it } from 'vitest';
import { createStageSurface } from './stage-surface';

describe('stage rendering fallback', () => {
	it('uses a separate 2D canvas when a browser refuses WebGL without losing the stage', () => {
		const context = { clearRect() {} };
		const gpuCanvas = Object.assign(new EventTarget(), { getContext: () => null, hidden: false }) as unknown as HTMLCanvasElement;
		const fallbackCanvas = { getContext: () => context, hidden: true } as unknown as HTMLCanvasElement;
		const surface = createStageSurface(gpuCanvas, fallbackCanvas, () => {});
		expect(surface?.canvas).toBe(fallbackCanvas);
		expect(surface?.painter).toBe(context);
		expect(gpuCanvas.hidden).toBe(true);
		expect(fallbackCanvas.hidden).toBe(false);
		surface?.destroy();
	});

	it('stays safe if neither rendering context is available', () => {
		const canvas = { getContext: () => null, hidden: false } as unknown as HTMLCanvasElement;
		expect(createStageSurface(canvas, canvas, () => {})).toBeNull();
	});
});
