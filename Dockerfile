# 1. Sabse halka Node.js version use karenge (Alpine Linux)
FROM node:18-alpine

# 2. Folder banayenge container ke andar
WORKDIR /app

# 3. Pehle sirf package files copy karenge (Caching ke liye best practice)
COPY package*.json ./

# 4. Dependencies install karenge
RUN npm install

# 5. Baaki code copy karenge
COPY . .

# 6. Port 80 kholenge (Server ke liye)
EXPOSE 80

# 7. App start karenge
CMD ["node", "index.js"]