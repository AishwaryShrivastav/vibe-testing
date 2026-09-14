FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ ./dist/
COPY server.json llms.txt llms-full.txt CLAUDE.md README.md CHANGELOG.md VIBE.example.md ./

RUN npx playwright install --with-deps chromium

ENTRYPOINT ["node", "dist/mcp-server.js"]
