# One image recipe for every TypeScript service (npm workspaces need the repo root as context):
#   docker build -f scripts/docker/node-service.Dockerfile --build-arg SERVICE=gateway .
# The service only needs a "start" script in services/<SERVICE>/package.json.
FROM node:26-bookworm-slim

ARG SERVICE
RUN test -n "$SERVICE" || (echo "build arg SERVICE is required" >&2 && exit 1)

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --no-audit --no-fund

ENV NODE_ENV=production \
    SERVICE=${SERVICE}
USER node
CMD ["sh", "-c", "exec npm run start --silent -w \"services/$SERVICE\""]
