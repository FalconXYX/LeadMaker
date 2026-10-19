# Python pipeline worker (job queue + schedules) and the one-shot Section 1 import (import-section1):
#   docker build -f scripts/docker/worker.Dockerfile .
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LEADMAKER_CACHE_DIR=/cache

WORKDIR /app
COPY pyproject.toml ./
COPY leadmaker ./leadmaker
RUN pip install ".[postgres,llm]" \
    && useradd --create-home --uid 10001 leadmaker \
    && mkdir -p /cache && chown leadmaker /cache
COPY examples ./examples
COPY --chmod=0755 scripts/docker/import-section1.sh /usr/local/bin/import-section1

USER leadmaker
CMD ["leadmaker", "worker"]
