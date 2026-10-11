# 소설 워드프로세서 동기화 서버 (앱 화면 포함)
# 저장소 맨 위 폴더에서: docker build -f server/Dockerfile -t novel-sync .
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:20-alpine
WORKDIR /app
COPY server/server.mjs ./server/server.mjs
COPY --from=build /src/dist ./dist
ENV PORT=8787 DATA_DIR=/data APP_DIR=/app/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
