#!/usr/bin/env node
/**
 * Spur MCP server.
 *
 * HTTP (default): remote connector for Claude and ChatGPT, protected by the Spur OAuth bridge.
 * stdio (TRANSPORT=stdio): local single-user mode for Claude Desktop / Claude Code, using SPUR_ACCESS_TOKEN.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHttpApp, resolveTokenSecret } from "./app.js";
import { Sealer } from "./auth/seal.js";
import { config, SERVER_NAME } from "./config.js";
import { createSpurServer } from "./server.js";
import { SpurClient, spurAuthCall } from "./spurApi.js";

function startStdio(sealer: Sealer) {
  if (!config.stdioAccessToken) {
    console.error("SPUR_ACCESS_TOKEN is required for stdio mode (copy it from a signed-in Spur session or the /api/auth/login response).");
    process.exit(1);
  }
  // Single local user, so rotating the refresh token in-process is safe here
  let refreshToken = config.stdioRefreshToken;
  const refresher = {
    async refresh() {
      if (!refreshToken) return null;
      const result = await spurAuthCall<{ success?: boolean; accessToken?: string; refreshToken?: string }>("/refresh", { refreshToken });
      if (!result.body.success || !result.body.accessToken) return null;
      refreshToken = result.body.refreshToken || refreshToken;
      return result.body.accessToken;
    }
  };
  const spur = new SpurClient(config.stdioAccessToken, refresher);
  serveStdio(() => createSpurServer(spur, sealer));
  console.error(`${SERVER_NAME} running on stdio against ${config.spurApiUrl}`);
}

function startHttp(sealer: Sealer) {
  createHttpApp(sealer).listen(config.port, config.host, () => {
    console.error(`${SERVER_NAME} listening on ${config.publicUrl}/mcp (bound ${config.host}:${config.port}) → Spur API ${config.spurApiUrl}`);
  });
}

const sealer = new Sealer(resolveTokenSecret());

if (process.env.TRANSPORT === "stdio") startStdio(sealer);
else startHttp(sealer);
