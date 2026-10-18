FROM node:22-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@11.3.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.3.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json LICENSE ./
RUN mkdir -p /home/node/.config/ssff-mcp /home/node/.cache/ssff-mcp \
    && chown -R node:node /home/node/.config /home/node/.cache
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js", "serve", "--config", "/home/node/.config/ssff-mcp/config.json"]
