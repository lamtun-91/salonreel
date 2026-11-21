FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js pipeline.js storage.js studio.js routes_studio.js shotstack.js music.js master.js avatar.js routes_avatar.js heygen.js heygen_client.js twin_render.js speech.js  runway.js runway_client.js spend.js promo_broll.js ./
COPY prompts ./prompts
COPY assets ./assets
COPY public ./public
COPY music ./music
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
