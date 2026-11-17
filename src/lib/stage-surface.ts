import { createWebGLPainter, type StagePainter } from './stage-webgl';

export function createStageSurface(canvas: HTMLCanvasElement, fallback: HTMLCanvasElement, invalidate: () => void) {
	let gpu: ReturnType<typeof createWebGLPainter> = null;
	try { gpu = createWebGLPainter(canvas); } catch {}
	let activeCanvas = canvas;
	let painter: StagePainter | CanvasRenderingContext2D | null = gpu;
	let disposed = false;
	function useFallback() {
		// 一个 canvas 一旦取得 WebGL context 就不能再切换成 2D，回退必须使用独立画布。
		painter = fallback.getContext('2d', { willReadFrequently: false });
		activeCanvas = fallback;
		canvas.hidden = true;
		fallback.hidden = false;
	}
	function lost(event: Event) {
		event.preventDefault();
		if (disposed) return;
		gpu?.destroy();
		gpu = null;
		useFallback();
		invalidate();
	}
	if (gpu) {
		canvas.hidden = false;
		fallback.hidden = true;
		canvas.addEventListener('webglcontextlost', lost);
	} else useFallback();
	if (!painter) return null;
	return {
		get canvas() { return activeCanvas; },
		get painter() { return painter; },
		paint(draw: () => void) {
			if (disposed || !painter) return;
			try { draw(); } catch (error) {
				if (!gpu) throw error;
				canvas.removeEventListener('webglcontextlost', lost);
				gpu.destroy();
				gpu = null;
				useFallback();
				if (painter) draw();
			}
		},
		destroy() {
			disposed = true;
			canvas.removeEventListener('webglcontextlost', lost);
			gpu?.destroy();
			gpu = null;
		}
	};
}
