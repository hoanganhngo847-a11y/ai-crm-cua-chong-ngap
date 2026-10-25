FROM node:20-bookworm-slim AS zcajs-build

ARG ZCAJS_REPO=https://github.com/ngogiaphat/ZCAJS.git
ARG ZCAJS_COMMIT=0d99d7d025f5183822d627088fac89d1f55ef691

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY patches/zcajs-old-direct-messages.patch /tmp/zcajs-old-direct-messages.patch
COPY patches/patch-zcajs-recent-rest.mjs /tmp/patch-zcajs-recent-rest.mjs
COPY patches/patch-zcajs-user-info.mjs /tmp/patch-zcajs-user-info.mjs
COPY patches/patch-zcajs-all-friends.mjs /tmp/patch-zcajs-all-friends.mjs

WORKDIR /src/zcajs
RUN git clone "$ZCAJS_REPO" . \
  && git checkout "$ZCAJS_COMMIT" \
  && git apply --check /tmp/zcajs-old-direct-messages.patch \
  && git apply /tmp/zcajs-old-direct-messages.patch \
  && node /tmp/patch-zcajs-recent-rest.mjs \
  && node /tmp/patch-zcajs-user-info.mjs \
  && node /tmp/patch-zcajs-all-friends.mjs \
  && npm install --no-audit --no-fund \
  && npm run build \
  && mkdir -p /out \
  && npm pack --pack-destination /out

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=10000
WORKDIR /app

COPY package.json ./package.json
COPY --from=zcajs-build /out/zca-js-1.2.1.tgz /tmp/zca-js.tgz
RUN npm install --omit=dev --no-audit --no-fund /tmp/zca-js.tgz \
  && rm -f /tmp/zca-js.tgz

COPY src ./src
COPY patches/patch-worker-contact-endpoint.mjs /tmp/patch-worker-contact-endpoint.mjs
COPY patches/patch-worker-phone-resolver.mjs /tmp/patch-worker-phone-resolver.mjs
RUN node /tmp/patch-worker-contact-endpoint.mjs \
  && node /tmp/patch-worker-phone-resolver.mjs \
  && node --check src/index.mjs \
  && rm -f /tmp/patch-worker-contact-endpoint.mjs /tmp/patch-worker-phone-resolver.mjs

EXPOSE 10000
CMD ["sh", "-c", "node src/dispatch-loop.mjs & exec node src/index.mjs"]
