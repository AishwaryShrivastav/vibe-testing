FROM node:20-slim

# Install Chromium dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY server.json llms.txt llms-full.txt CLAUDE.md README.md CHANGELOG.md VIBE.example.md ./

# Install Playwright Chromium
RUN npx playwright install chromium

# MCP server runs over stdio
ENTRYPOINT ["node", "dist/mcp-server.js"]
