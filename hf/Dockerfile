FROM node:22-alpine
RUN apk add --no-cache git && mkdir -p /home/node/app && chown node:node /home/node/app
USER node
WORKDIR /home/node/app
# Pulls the game code from GitHub when the Space builds. To ship an update, push to GitHub and
# press "Factory rebuild" in the Space settings.
RUN git clone --depth 1 https://github.com/neymarkali/draft-duel.git .
ENV PORT=7860 DB_PATH=/home/node/app/data/draft-duel.db
EXPOSE 7860
CMD ["node", "--no-warnings", "server.js"]
