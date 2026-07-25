ARG BASE_IMAGE=los-ci:node22-jj0.39.0
FROM ${BASE_IMAGE}

ARG PLAYWRIGHT_VERSION=1.61.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Keep Chromium and its Debian runtime libraries in the runner image. The
# workspace still supplies @playwright/test from its pinned lockfile.
RUN set -eux; \
    npm exec --yes --package="playwright@${PLAYWRIGHT_VERSION}" -- \
      playwright install --with-deps chromium; \
    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"; \
    npm cache clean --force; \
    test -n "$(find "${PLAYWRIGHT_BROWSERS_PATH}" -type f -name chrome -print -quit)"
