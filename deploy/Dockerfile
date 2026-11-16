ARG NODE_IMAGE=node:24.12.0-bookworm-slim
FROM ${NODE_IMAGE}
ENV PUPPETEER_SKIP_DOWNLOAD=true HYPIT_CHROME_PATH=/usr/bin/chromium NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.33.0 --ignore-scripts
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/app/deploy/ffmpeg-low-memory.sh FFPROBE_PATH=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
COPY --chown=node:node vendor/hypit/ ./vendor/hypit/
RUN cd vendor/hypit && NODE_OPTIONS=--max-old-space-size=192 NODE_ENV=development pnpm install --frozen-lockfile --ignore-scripts --network-concurrency=4 --child-concurrency=1
COPY --chown=node:node . .
RUN mkdir -p /app/integrations/hypit-volcano/node_modules/@hypit \
    && for package in hypit runtime-local generation narrative media temporal narrative-temporal speech-evidence narrative-speech-alignment; do \
      if [ "$package" = hypit ]; then target=/app/vendor/hypit; else target=/app/vendor/hypit/packages/$package; fi; \
      ln -s "$target" "/app/integrations/hypit-volcano/node_modules/@hypit/$package"; \
    done \
    && mkdir -p /app/runs && chown node:node /app/runs \
    && chmod 755 /app/deploy/ffmpeg-low-memory.sh
RUN apt-get update && apt-get install -y --no-install-recommends chromium-headless-shell && rm -rf /var/lib/apt/lists/*
ENV HYPIT_CHROME_PATH=/usr/bin/chromium-headless-shell
USER node
EXPOSE 4173
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/cli.ts", "serve", "--host", "0.0.0.0"]
