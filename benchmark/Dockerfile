# Builds the benchmark service (Requirement 3): Node.js serves the API, k6 generates the load.
# The build context is the repository root (see docker-compose.yml), so the image runs the team's own
# k6 workloads and proofs from api-tests/task3, not a copy of them.

# k6 is one static binary: take it from the official image instead of installing it.
FROM grafana/k6:2.3.0 AS k6

FROM node:22-alpine
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
# Fixed, validated fixture scripts run through psql; no Docker socket is exposed.
RUN apk add --no-cache postgresql17-client

# Same folder layout as the repository, so the service finds ../../api-tests/task3 in both places.
WORKDIR /app/benchmark
COPY benchmark/package.json ./
COPY benchmark/src/ ./src/
COPY api-tests/task3/ /app/api-tests/task3/
COPY seed/custom-benchmark-*.sql /app/seed/

# Results go to a mounted folder (task3-results/ in the repository), shared with the CLI scripts.
RUN mkdir -p /results && chown node /results
ENV RESULTS_DIR=/results

# The node image has a non-root user called "node".
USER node

EXPOSE 8090
CMD ["node", "src/server.js"]
