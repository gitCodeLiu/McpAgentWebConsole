FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV MCP_AGENT_WEB_HOST=0.0.0.0
ENV MCP_AGENT_WEB_PORT=8765

COPY --from=build /app/server.mjs ./
COPY --from=build /app/dist ./dist

EXPOSE 8765

CMD ["node", "server.mjs"]
