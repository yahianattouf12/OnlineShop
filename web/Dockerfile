# Builds the frontend in two stages: Node to compile it, then a small nginx image to serve the files.

# ---------- Stage 1: build ----------
FROM node:22-alpine AS build
WORKDIR /web

# Install packages first so Docker caches this layer until package-lock.json changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- Stage 2: serve ----------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
