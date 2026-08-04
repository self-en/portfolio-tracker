FROM node:24-alpine
WORKDIR /app

# The scaffold deliberately ships WITHOUT a package-lock.json (it can't be
# generated offline at scaffold time), so use `npm install`, not `npm ci`.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

USER node
CMD ["node", "server.js"]
