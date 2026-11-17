FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
	&& apt-get install --no-install-recommends -y ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	BODY_SIZE_LIMIT=Infinity \
	FFMPEG_PATH=/usr/bin/ffmpeg \
	FFPROBE_PATH=/usr/bin/ffprobe \
	SHARE_DATABASE_PATH=/app/data/shares.sqlite \
	SHARE_MEDIA_DIRECTORY=/app/data/media

WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/data/media && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "build"]
