export function createAudioSpectrum(audio: HTMLAudioElement) {
	let context: AudioContext | undefined;
	let source: MediaElementAudioSourceNode | undefined;
	let analyser: AnalyserNode | undefined;
	let samples: Uint8Array<ArrayBuffer> | undefined;
	return {
		async prepare(): Promise<boolean> {
			if (typeof AudioContext === 'undefined') return false;
			try {
				context ??= new AudioContext();
				// 只在点击播放时请求恢复；恢复失败前不劫持原生音频的输出路径。
				await context.resume();
				if (context.state !== 'running') return false;
				if (!source) {
					analyser = context.createAnalyser();
					analyser.fftSize = 512;
					analyser.smoothingTimeConstant = .72;
					samples = new Uint8Array(analyser.frequencyBinCount);
					source = context.createMediaElementSource(audio);
					source.connect(analyser);
					analyser.connect(context.destination);
				}
				return true;
			} catch {
				return false;
			}
		},
		levels(): number[] | null {
			if (!analyser || !samples || context?.state !== 'running') return null;
			analyser.getByteFrequencyData(samples);
			const count = 24;
			return Array.from({ length: count }, (_, index) => {
				const from = Math.floor((Math.pow(index / count, 2) * .85) * samples!.length);
				const to = Math.max(from + 1, Math.floor((Math.pow((index + 1) / count, 2) * .85) * samples!.length));
				let peak = 0;
				for (let bin = from; bin < Math.min(to, samples!.length); bin++) peak = Math.max(peak, samples![bin]);
				return peak / 255;
			});
		},
		destroy() {
			source?.disconnect();
			analyser?.disconnect();
			void context?.close().catch(() => undefined);
		}
	};
}
