FROM oven/bun:1.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
ENV NODE_ENV=production PORT=3006
EXPOSE 3006
USER bun
CMD ["bun", "src/server.ts"]
