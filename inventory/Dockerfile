# Builds the image of the inventory service (Node.js).
# The build context is the repository root (see docker-compose.yml), so we can COPY proto/ too.
FROM node:22-alpine

# Same folder layout as the repository: /app/inventory and /app/proto,
# so server.js finds the contract at ../../proto/inventory.proto in both places.
WORKDIR /app/inventory

# Install the packages first, so Docker reuses this layer until package*.json change.
COPY inventory/package.json inventory/package-lock.json ./
RUN npm ci --omit=dev

COPY proto/ /app/proto/
COPY inventory/src/ ./src/

# The node image has a non-root user called "node".
USER node

EXPOSE 50051
CMD ["node", "src/server.js"]