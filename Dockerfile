# Continuity tracker — portable demo image ("runs on whatever platform").
#
# The server has ZERO npm runtime dependencies, so there is no `npm install`:
# all it needs is Node 24 (for native TypeScript type-stripping + node:sqlite)
# and the source. It boots in fixture mode (the frozen real-track snapshot), so
# there is no network access and no Movebank secret required to run the demo.
FROM node:24-slim

WORKDIR /app

# Source only. .dockerignore keeps .env, node_modules, *.db, screenshots out.
COPY . .

# Fixture mode is the default; a host (Fly/Render/Railway/Cloud Run) may inject
# its own $PORT, which src/config.ts already honors.
ENV NODE_ENV=production \
    MOVEBANK_MODE=fixture \
    PORT=8787
EXPOSE 8787

# Seed the SQLite db from the committed fixture, then serve. Deterministic,
# offline, credential-free.
CMD ["sh", "-c", "npm run seed && npm start"]
