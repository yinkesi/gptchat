# ---------- 构建 ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
COPY bridge/package.json bridge/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY server server
COPY web web
COPY bridge bridge
COPY scripts scripts
RUN npm run build -w @gptchat/shared && npm run build -w @gptchat/server && npm run build -w web

# ---------- 运行 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S gptchat && adduser -S gptchat -G gptchat
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
USER gptchat
EXPOSE 8780
ENV PORT=8780 HOST=0.0.0.0 DB_PATH=/data/gptchat.db
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8780/healthz || exit 1
CMD ["node", "server/dist/index.js"]
