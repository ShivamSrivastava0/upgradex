FROM node:22-alpine

FROM node:22-slim AS production

WORKDIR /app

COPY package*.json ./

CMD ["node", "src/index.ts"]
