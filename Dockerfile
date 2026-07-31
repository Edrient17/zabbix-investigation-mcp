FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Drop root for the runtime. This process holds a Zabbix API token and reaches
# the monitoring network, so it should not also own the container it runs in.
# Port 3000 is unprivileged, and the app only ever reads its own files.
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
