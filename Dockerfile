FROM oven/bun:1.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
# El proceso corre como el usuario "bun" (sin privilegios): necesita poder escribir en out/.
RUN mkdir -p /app/out && chown -R bun:bun /app/out
ENV NODE_ENV=production PORT=3006
EXPOSE 3006
USER bun
CMD ["bun", "src/server.ts"]
