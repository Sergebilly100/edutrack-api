# Étape 1 : Build de l'application
FROM node:23.9.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# --- Étape de Production ---
FROM node:23.9.0-alpine
RUN apk add --no-cache zlib=1.3.2-r0

WORKDIR /app

COPY --from=build /app/dist .
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/templates ./templates

ENV NODE_OPTIONS="--max-old-space-size=5120"
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"] 
