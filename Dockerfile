# Jeddah Trading backend — pins Node 22 (built-in SQLite), zero npm install needed.
FROM node:22-alpine

WORKDIR /app
COPY . .

# Store the database + uploaded images on a persistent volume in production.
ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
