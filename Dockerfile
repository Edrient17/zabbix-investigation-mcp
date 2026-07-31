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

EXPOSE 3000
CMD ["node", "dist/server.js"]
