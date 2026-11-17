type Gradient = { addColorStop(offset: number, color: string): void };
export type StagePainter = {
	font: string;
	textAlign: CanvasTextAlign;
	textBaseline: CanvasTextBaseline;
	globalAlpha: number;
	fillStyle: string | Gradient;
	strokeStyle: string;
	lineWidth: number;
	filter: string;
	shadowColor: string;
	shadowBlur: number;
	save(): void;
	restore(): void;
	translate(x: number, y: number): void;
	rotate(angle: number): void;
	scale(x: number, y: number): void;
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
	measureText(text: string): TextMetrics;
	fillText(text: string, x: number, y: number): void;
	clearRect(x: number, y: number, width: number, height: number): void;
	fillRect(x: number, y: number, width: number, height: number): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	stroke(): void;
	roundRect(x: number, y: number, width: number, height: number, radius: number): void;
	clip(): void;
	createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Gradient;
	drawImage(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
};

type Rect = { x: number; y: number; width: number; height: number; radius: number };
type Texture = { handle: WebGLTexture; width: number; height: number; contentWidth: number; contentHeight: number; padding: number };
type PaintState = {
	font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline;
	globalAlpha: number; fillStyle: string | Gradient; strokeStyle: string; lineWidth: number;
	filter: string; shadowColor: string; shadowBlur: number; transform: DOMMatrix; clip: Rect | null;
};

class RadialGradient implements Gradient {
	stops: Array<{ offset: number; color: string }> = [];
	constructor(readonly x: number, readonly y: number, readonly radius: number) {}
	addColorStop(offset: number, color: string) { this.stops.push({ offset, color }); this.stops.sort((first, second) => first.offset - second.offset); }
}

const vertexShader = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
uniform vec2 uResolution;
out vec2 vUV;
out vec2 vPosition;
void main() {
	vUV = aUV;
	vPosition = aPosition;
	gl_Position = vec4(aPosition / uResolution * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const fragmentShader = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec4 uColor;
uniform vec4 uClip;
uniform float uClipRadius;
uniform vec3 uGradient;
uniform vec4 uGradientEnd;
uniform vec2 uBlur;
uniform int uKind;
in vec2 vUV;
in vec2 vPosition;
out vec4 outputColor;
void main() {
	vec4 color = uColor;
	if (uKind == 1 || uKind == 2) {
		vec4 pixel = texture(uTexture, vUV);
		if (uKind == 1) {
			float alpha = pixel.a;
			if (uBlur.x > 0.0) {
				alpha = 0.0;
				for (int row = -2; row <= 2; row++) {
					for (int column = -2; column <= 2; column++) {
						vec2 offset = vec2(float(column), float(row));
						float weight = exp(-dot(offset, offset) / 2.0);
						alpha += texture(uTexture, vUV + offset * uBlur).a * weight / 6.168924;
					}
				}
			}
			color.a *= alpha;
		} else color *= pixel;
	} else if (uKind == 3) {
		float progress = clamp(distance(vPosition, uGradient.xy) / uGradient.z, 0.0, 1.0);
		color = mix(uColor, uGradientEnd, progress);
	}
	if (uClip.z > 0.0) {
		vec2 halfSize = uClip.zw / 2.0;
		vec2 edge = abs(vPosition - uClip.xy - halfSize) - halfSize + uClipRadius;
		float distanceToEdge = length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0) - uClipRadius;
		color.a *= 1.0 - smoothstep(-0.5, 0.5, distanceToEdge);
	}
	outputColor = vec4(color.rgb * color.a, color.a);
}`;

export function createWebGLPainter(canvas: HTMLCanvasElement) {
	const gl = canvas.getContext('webgl2', {
		alpha: true, depth: false, stencil: false, antialias: false,
		premultipliedAlpha: true, preserveDrawingBuffer: false,
		powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true
	});
	if (!gl) return null;
	return new WebGLPainter(canvas, gl);
}

class WebGLPainter implements StagePainter {
	private state: PaintState = {
		font: '800 16px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
		globalAlpha: 1, fillStyle: '#fff', strokeStyle: '#fff', lineWidth: 1,
		filter: 'none', shadowColor: 'transparent', shadowBlur: 0, transform: new DOMMatrix(), clip: null
	};
	private stack: PaintState[] = [];
	private path: Array<[number, number, boolean]> = [];
	private rectangle: Rect | null = null;
	private textures = new Map<string | HTMLImageElement, Texture>();
	private textureBytes = 0;
	private colors = new Map<string, number[]>();
	private measure = document.createElement('canvas').getContext('2d')!;
	private colorSampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
	private program: WebGLProgram;
	private buffer: WebGLBuffer;
	private white: WebGLTexture;
	private vertices = new Float32Array(24);
	private uniforms: Record<string, WebGLUniformLocation | null> = {};
	private maxTextureSize: number;
	private rasterScale = Math.min(2, window.devicePixelRatio || 1);
	private disposed = false;

	constructor(private canvas: HTMLCanvasElement, private gl: WebGL2RenderingContext) {
		const shaders: WebGLShader[] = [];
		const program = gl.createProgram();
		const buffer = gl.createBuffer();
		const white = gl.createTexture();
		if (!program || !buffer || !white) {
			gl.deleteProgram(program);
			gl.deleteBuffer(buffer);
			gl.deleteTexture(white);
			throw new Error('GPU resources unavailable');
		}
		this.program = program;
		this.buffer = buffer;
		this.white = white;
		try {
			for (const [kind, source] of [[gl.VERTEX_SHADER, vertexShader], [gl.FRAGMENT_SHADER, fragmentShader]] as const) {
				const shader = gl.createShader(kind);
				if (!shader) throw new Error('GPU shader unavailable');
				shaders.push(shader);
				gl.shaderSource(shader, source);
				gl.compileShader(shader);
				if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'GPU shader failed');
				gl.attachShader(program, shader);
			}
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('GPU shader linking failed');
			gl.useProgram(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
			for (const [name, offset] of [['aPosition', 0], ['aUV', 8]] as const) {
				const attribute = gl.getAttribLocation(program, name);
				gl.enableVertexAttribArray(attribute);
				gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 16, offset);
			}
			for (const name of ['Resolution', 'Texture', 'Color', 'Clip', 'ClipRadius', 'Gradient', 'GradientEnd', 'Blur', 'Kind']) {
				this.uniforms[name] = gl.getUniformLocation(program, `u${name}`);
			}
			gl.uniform1i(this.uniforms.Texture, 0);
			gl.bindTexture(gl.TEXTURE_2D, white);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.enable(gl.BLEND);
			// 着色器输出预乘 alpha，与透明 canvas 合成一致，避免文字和封面边缘出现黑边。
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
		} catch (error) {
			gl.deleteProgram(program);
			gl.deleteBuffer(buffer);
			gl.deleteTexture(white);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
			throw error;
		} finally {
			for (const shader of shaders) gl.deleteShader(shader);
		}
		this.colorSampler.canvas.width = this.colorSampler.canvas.height = 1;
	}

	get font() { return this.state.font; }
	set font(value: string) { this.state.font = value; }
	get textAlign() { return this.state.textAlign; }
	set textAlign(value: CanvasTextAlign) { this.state.textAlign = value; }
	get textBaseline() { return this.state.textBaseline; }
	set textBaseline(value: CanvasTextBaseline) { this.state.textBaseline = value; }
	get globalAlpha() { return this.state.globalAlpha; }
	set globalAlpha(value: number) { if (value >= 0 && value <= 1) this.state.globalAlpha = value; }
	get fillStyle() { return this.state.fillStyle; }
	set fillStyle(value: string | Gradient) { this.state.fillStyle = value; }
	get strokeStyle() { return this.state.strokeStyle; }
	set strokeStyle(value: string) { this.state.strokeStyle = value; }
	get lineWidth() { return this.state.lineWidth; }
	set lineWidth(value: number) { this.state.lineWidth = value; }
	get filter() { return this.state.filter; }
	set filter(value: string) { this.state.filter = value; }
	get shadowColor() { return this.state.shadowColor; }
	set shadowColor(value: string) { this.state.shadowColor = value; }
	get shadowBlur() { return this.state.shadowBlur; }
	set shadowBlur(value: number) { this.state.shadowBlur = value; }
	save() { this.stack.push({ ...this.state, transform: DOMMatrix.fromMatrix(this.state.transform) }); }
	restore() { this.state = this.stack.pop() ?? this.state; }
	translate(x: number, y: number) { this.state.transform.translateSelf(x, y); }
	rotate(angle: number) { this.state.transform.rotateSelf(angle * 180 / Math.PI); }
	scale(x: number, y: number) { this.state.transform.scaleSelf(x, y); }
	setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { this.state.transform = new DOMMatrix([a, b, c, d, e, f]); }
	measureText(text: string) { this.measure.font = this.font; return this.measure.measureText(text); }

	clearRect() {
		const gl = this.gl;
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.useProgram(this.program);
		gl.uniform2f(this.uniforms.Resolution, this.canvas.width, this.canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		const scale = Math.min(2, window.devicePixelRatio || 1);
		if (scale !== this.rasterScale) {
			this.clearTextures();
			this.rasterScale = scale;
		}
	}

	private color(value: string) {
		let color = this.colors.get(value);
		if (!color) {
			this.colorSampler.clearRect(0, 0, 1, 1);
			this.colorSampler.fillStyle = value;
			this.colorSampler.fillRect(0, 0, 1, 1);
			color = Array.from(this.colorSampler.getImageData(0, 0, 1, 1).data, (channel) => channel / 255);
			if (this.colors.size >= 128) this.colors.delete(this.colors.keys().next().value!);
			this.colors.set(value, color);
		}
		return [color[0], color[1], color[2], color[3] * this.globalAlpha];
	}

	private upload(key: string | HTMLImageElement, image: HTMLCanvasElement, width: number, height: number, padding = 0): Texture {
		const gl = this.gl;
		const bytes = image.width * image.height * 4;
		// 歌词再长也只保留最近的纹理，手机端不随播放时长无限占用显存。
		while (this.textures.size && (this.textureBytes + bytes > 16 * 1024 * 1024 || this.textures.size >= 256)) {
			const oldest = this.textures.keys().next().value!;
			const entry = this.textures.get(oldest)!;
			gl.deleteTexture(entry.handle);
			this.textureBytes -= entry.width * entry.height * 4;
			this.textures.delete(oldest);
		}
		const handle = gl.createTexture();
		if (!handle) throw new Error('GPU texture unavailable');
		gl.bindTexture(gl.TEXTURE_2D, handle);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
		const entry = { handle, width: image.width, height: image.height, contentWidth: width, contentHeight: height, padding };
		this.textures.set(key, entry);
		this.textureBytes += bytes;
		return entry;
	}

	private cached(key: string | HTMLImageElement) {
		const texture = this.textures.get(key);
		if (texture) { this.textures.delete(key); this.textures.set(key, texture); }
		return texture;
	}

	fillText(text: string, x: number, y: number) {
		if (!text || this.globalAlpha === 0) return;
		const key = `${this.font}\u0000${text}`;
		let texture = this.cached(key);
		if (!texture) {
			const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16);
			const padding = 24;
			const width = Math.max(1, this.measureText(text).width);
			const height = Math.ceil(size * 1.8);
			const image = document.createElement('canvas');
			const ratio = Math.min(this.rasterScale, this.maxTextureSize / (width + padding * 2), this.maxTextureSize / (height + padding * 2));
			image.width = Math.max(1, Math.ceil((width + padding * 2) * ratio));
			image.height = Math.max(1, Math.ceil((height + padding * 2) * ratio));
			const context = image.getContext('2d')!;
			context.scale(ratio, ratio);
			context.font = this.font;
			context.textBaseline = 'middle';
			context.fillStyle = '#fff';
			context.fillText(text, padding, padding + height / 2);
			texture = this.upload(key, image, width, height, padding);
		}
		const left = x - (this.textAlign === 'center' ? texture.contentWidth / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? texture.contentWidth : 0) - texture.padding;
		const top = y - texture.contentHeight / 2 - texture.padding;
		const width = texture.contentWidth + texture.padding * 2;
		const height = texture.contentHeight + texture.padding * 2;
		const blur = Number(this.filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0);
		if (this.shadowBlur > 0) this.quad(left, top, width, height, this.color(this.shadowColor), 1, texture, Math.max(blur, this.shadowBlur / 2));
		this.quad(left, top, width, height, this.color(typeof this.fillStyle === 'string' ? this.fillStyle : '#fff'), 1, texture, blur);
	}

	fillRect(x: number, y: number, width: number, height: number) {
		if (this.fillStyle instanceof RadialGradient) {
			const gradient = this.fillStyle;
			this.quad(x, y, width, height, this.color(gradient.stops[0]?.color ?? 'transparent'), 3, undefined, 0, gradient);
		} else this.quad(x, y, width, height, this.color(typeof this.fillStyle === 'string' ? this.fillStyle : '#fff'), 0);
	}
	beginPath() { this.path = []; this.rectangle = null; }
	moveTo(x: number, y: number) { this.path.push([x, y, false]); }
	lineTo(x: number, y: number) { this.path.push([x, y, true]); }
	stroke() {
		for (let index = 1; index < this.path.length; index++) {
			const [x, y, connected] = this.path[index];
			if (!connected) continue;
			const [fromX, fromY] = this.path[index - 1];
			this.save();
			this.translate(fromX, fromY);
			this.rotate(Math.atan2(y - fromY, x - fromX));
			this.quad(0, -this.lineWidth / 2, Math.hypot(x - fromX, y - fromY), this.lineWidth, this.color(this.strokeStyle), 0);
			this.restore();
		}
	}
	roundRect(x: number, y: number, width: number, height: number, radius: number) { this.rectangle = { x, y, width, height, radius }; }
	clip() { this.state.clip = this.rectangle; }
	createRadialGradient(_x0: number, _y0: number, _r0: number, x: number, y: number, radius: number) { return new RadialGradient(x, y, radius); }
	drawImage(image: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
		let texture = this.cached(image);
		if (!texture) {
			const raster = document.createElement('canvas');
			const ratio = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
			raster.width = Math.max(1, Math.round(image.naturalWidth * ratio));
			raster.height = Math.max(1, Math.round(image.naturalHeight * ratio));
			raster.getContext('2d')!.drawImage(image, 0, 0, raster.width, raster.height);
			texture = this.upload(image, raster, image.naturalWidth, image.naturalHeight);
		}
		this.quad(dx, dy, dw, dh, [1, 1, 1, this.globalAlpha], 2, texture, 0, undefined,
			[sx / image.naturalWidth, sy / image.naturalHeight, (sx + sw) / image.naturalWidth, (sy + sh) / image.naturalHeight]);
	}

	private quad(x: number, y: number, width: number, height: number, color: number[], kind: number, texture?: Texture, blur = 0, gradient?: RadialGradient, uv = [0, 0, 1, 1]) {
		if (this.disposed || width <= 0 || height <= 0) return;
		const gl = this.gl;
		const transform = this.state.transform;
		const corners = [[x, y, uv[0], uv[1]], [x + width, y, uv[2], uv[1]], [x, y + height, uv[0], uv[3]], [x + width, y + height, uv[2], uv[3]]];
		[0, 1, 2, 2, 1, 3].forEach((corner, index) => {
			const [localX, localY, textureX, textureY] = corners[corner];
			this.vertices.set([transform.a * localX + transform.c * localY + transform.e, transform.b * localX + transform.d * localY + transform.f, textureX, textureY], index * 4);
		});
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices);
		gl.uniform4fv(this.uniforms.Color, color);
		gl.uniform1i(this.uniforms.Kind, kind);
		gl.uniform2f(this.uniforms.Blur, texture ? blur * this.rasterScale / texture.width / 2 : 0, texture ? blur * this.rasterScale / texture.height / 2 : 0);
		gl.bindTexture(gl.TEXTURE_2D, texture?.handle ?? this.white);
		const clip = this.state.clip;
		gl.uniform4f(this.uniforms.Clip, clip ? transform.a * clip.x + transform.e : 0, clip ? transform.d * clip.y + transform.f : 0, clip ? clip.width * transform.a : 0, clip ? clip.height * transform.d : 0);
		gl.uniform1f(this.uniforms.ClipRadius, clip ? clip.radius * transform.a : 0);
		if (gradient) {
			gl.uniform3f(this.uniforms.Gradient, gradient.x * transform.a + transform.e, gradient.y * transform.d + transform.f, gradient.radius * transform.a);
			gl.uniform4fv(this.uniforms.GradientEnd, this.color(gradient.stops.at(-1)?.color ?? 'transparent'));
		}
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}

	private clearTextures() {
		for (const texture of this.textures.values()) this.gl.deleteTexture(texture.handle);
		this.textures.clear();
		this.textureBytes = 0;
	}
	destroy() {
		if (this.disposed) return;
		this.disposed = true;
		this.clearTextures();
		this.colors.clear();
		this.gl.deleteBuffer(this.buffer);
		this.gl.deleteProgram(this.program);
		this.gl.deleteTexture(this.white);
		// 离开律动页后立即释放绘图缓冲，反复切换也不会累积浏览器 WebGL context。
		if (!this.gl.isContextLost()) this.gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}
