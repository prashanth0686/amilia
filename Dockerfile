FROM node:20-slim

WORKDIR /app

# Install deps first for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Cloud Run provides PORT env var automatically
EXPOSE 8080

CMD ["npm", "start"]
