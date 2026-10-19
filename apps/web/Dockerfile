# Build context: the repo root (the app type-checks against packages/shared/src):
#   docker build -f apps/web/Dockerfile -t leadmaker-web .
FROM node:24-alpine AS build
WORKDIR /app
COPY packages/shared/src packages/shared/src
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
ARG VITE_TILE_URL
ARG VITE_TILE_ATTRIBUTION
ARG VITE_DEMO_MODE
ARG VITE_DEFAULT_DEMO_USER
ENV VITE_TILE_URL=${VITE_TILE_URL} VITE_TILE_ATTRIBUTION=${VITE_TILE_ATTRIBUTION} \
    VITE_DEMO_MODE=${VITE_DEMO_MODE} VITE_DEFAULT_DEMO_USER=${VITE_DEFAULT_DEMO_USER}
RUN npm run build

FROM nginx:1.29-alpine
# The official image renders /etc/nginx/templates/*.template with envsubst into conf.d at start.
ENV GATEWAY_URL=http://gateway:8080 \
    NGINX_RESOLVER=127.0.0.11
RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
