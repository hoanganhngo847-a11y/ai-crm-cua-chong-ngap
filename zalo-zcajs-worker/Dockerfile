FROM node:20-bookworm-slim AS zcajs-build

ARG ZCAJS_REPO=https://github.com/ngogiaphat/ZCAJS.git
ARG ZCAJS_COMMIT=0d99d7d025f5183822d627088fac89d1f55ef691

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src/zcajs
RUN git clone "$ZCAJS_REPO" . \
  && git checkout "$ZCAJS_COMMIT" \
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

EXPOSE 10000
CMD ["node", "src/index.mjs"]
