FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY public ./public

ENV PORT=8000
EXPOSE 8000

# Route state (routes.json) lives here instead of the project root so it can
# be backed by a mounted volume - without a volume mount, this directory is
# part of the container's writable layer and routes are lost whenever the
# container is recreated/restarted.
ENV ROUTES_FILE=/app/data/routes.json
VOLUME ["/app/data"]

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
