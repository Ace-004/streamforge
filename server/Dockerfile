#--- Base ---
  FROM node:20-alpine AS base
  WORKDIR /app
  RUN apk add --no-cache ffmpeg

  #--- Dependencies ---
    FROM base AS deps
    COPY package.json package-lock.json ./
    RUN npm ci

    #--- Build ---
      FROM base AS build
      COPY --from=deps /apps/node_modules ./node_modules
      COPY . .
      RUN npx prisma generate
      RUN npm run build


      #--- Production ---
      FROM base AS production
      ENV NODE_ENV=production
      COPY package.json package-lock.json ./
      RUN npm ci --omit=dev
      COPY --from=build /app/dist ./dist
      COPY --from=build /app/src/generated ./src/generated
      COPY prisma ./prisma
      COPY prisma.config.ts ./

      EXPOSE 4000
      CMD ["node","dist/index.js"]