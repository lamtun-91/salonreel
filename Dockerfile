FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js pipeline.js ./
COPY prompts ./prompts
COPY assets ./assets
COPY public ./public
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
