FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    BUSINESS_TIME_ZONE=Asia/Shanghai \
    WRANGLER_LOG_PATH=/tmp/ontoquery-wrangler.log

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8787/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_API_WRITE_TOKEN=""

COPY package.json package-lock.json ./
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g; s|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --include=dev \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build \
 && mkdir -p /var/lib/ontoquery/data /var/lib/ontoquery/wiki \
 && chown -R node:node /app /var/lib/ontoquery

USER node
EXPOSE 3000 8787
VOLUME ["/var/lib/ontoquery/data", "/var/lib/ontoquery/wiki"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8787/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm","run","serve"]
