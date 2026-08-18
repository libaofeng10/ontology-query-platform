FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    WRANGLER_LOG_PATH=/tmp/ontoquery-wrangler.log

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8787/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_API_WRITE_TOKEN=""

COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build \
 && mkdir -p /var/lib/ontoquery/data /var/lib/ontoquery/wiki \
 && chown -R node:node /app /var/lib/ontoquery

USER node
EXPOSE 3000 8787
VOLUME ["/var/lib/ontoquery/data", "/var/lib/ontoquery/wiki"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:8787/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm","run","serve"]
