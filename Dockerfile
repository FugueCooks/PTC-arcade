FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/index.html /app/player.html /app/style.css /app/app-bootstrap.js /app/arcade.js /app/avatar-selection.js /app/multiplayer-client.js ./
COPY --from=build /app/assets ./assets
COPY --from=build /app/avatars ./avatars
COPY --from=build /app/cabinets ./cabinets
COPY --from=build /app/emulators ./emulators
COPY --from=build /app/social ./social
COPY --from=build /app/world ./world
COPY --from=build /app/realtime ./realtime
COPY --from=build /app/wallet ./wallet
COPY --from=build /app/games ./games
COPY --from=build /app/rooms ./rooms
# Served by the operations routes when OPERATIONS_OPERATORS is set, and loaded
# by the plugin host for any ID in ENABLED_PLUGINS. Both are off by default,
# which is exactly why a missing directory would only surface the first time an
# operator turned one on. test/image-contents.test.ts holds this list to what
# the server actually reads at runtime.
COPY --from=build /app/ops-dashboard ./ops-dashboard
COPY --from=build /app/plugins ./plugins
EXPOSE 8080
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node dist/server/src/database/migrate.js; fi && exec node dist/server/src/index.js"]
