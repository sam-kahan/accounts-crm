# ---- build stage: install deps + build the React client -------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install all workspace deps (root + server + client)
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install

# Copy source and build the client
COPY . .
RUN npm run build -w client

# ---- runtime stage: server + built client only ----------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
# Only production deps for the server
RUN npm install --omit=dev -w server

COPY server ./server
COPY --from=build /app/client/dist ./client/dist

EXPOSE 4000
# Run migrations then start the API (which also serves the built client)
CMD ["sh", "-c", "npm run migrate -w server && npm run start -w server"]
