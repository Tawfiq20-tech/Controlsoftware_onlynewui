# ── Stage 1: Build ─────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /app

# Allow build-time API URL for same-origin in production (empty = use relative /api)
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Serve with nginx ─────────────────────────────────
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
