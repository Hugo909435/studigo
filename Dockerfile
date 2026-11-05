FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/app/data
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 4310
CMD ["node", "server.mjs"]
