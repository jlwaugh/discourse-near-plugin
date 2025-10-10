import { createLocalPluginRuntime } from "every-plugin/testing";
import { createServer, IncomingMessage, ServerResponse } from "http";
import DiscoursePlugin from "./index";

const pluginMap = {
  "discourse-near": DiscoursePlugin,
} as const;

async function start() {
  console.log("Starting Discourse NEAR Plugin Server with User API...\n");

  // Check environment variables
  const requiredEnvVars = ["DISCOURSE_BASE_URL", "DISCOURSE_API_KEY"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.error(`❌ Missing ${envVar} in .env`);
      process.exit(1);
    }
  }

  console.log("✓ Environment variables loaded");
  console.log(`✓ Discourse URL: ${process.env.DISCOURSE_BASE_URL}`);
  console.log(`✓ Using Discourse User API (no OAuth app needed!)\n`);

  // Create plugin runtime
  const runtime = createLocalPluginRuntime(
    {
      registry: {
        "discourse-near": {
          remoteUrl: "http://localhost:3001/remoteEntry.js",
          version: "0.0.1",
        },
      },
      secrets: {
        DISCOURSE_API_KEY: process.env.DISCOURSE_API_KEY ?? "",
      },
    },
    pluginMap
  );

  // Use plugin
  const { client, initialized } = await runtime.usePlugin("discourse-near", {
    secrets: {
      discourseApiKey: "{{DISCOURSE_API_KEY}}",
    },
    variables: {
      discourseBaseUrl: process.env.DISCOURSE_BASE_URL!,
      discourseApiUsername: process.env.DISCOURSE_API_USERNAME || "system",
      applicationName: process.env.APPLICATION_NAME || "NEAR Account Link",
      clientId: process.env.CLIENT_ID || "discourse-near-plugin",
      recipient: process.env.DISCOURSE_RECIPIENT || "social.near",
    },
  });

  console.log("✓ Plugin initialized\n");

  // Create HTTP server
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      // Handle preflight
      if (req.method === "OPTIONS") {
        res.statusCode = 200;
        res.end();
        return;
      }

      // Parse URL
      const url = new URL(req.url!, `http://${req.headers.host}`);

      // Health check
      if (url.pathname === "/health") {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            status: "ok",
            plugin: "discourse-near",
            authMethod: "user-api",
          })
        );
        return;
      }

      if (url.pathname === "/auth/callback") {
        const payload = url.searchParams.get("payload");

        console.log("[Callback] Received User API callback");
        console.log("[Callback] Payload:", payload ? "present" : "missing");

        res.setHeader("Content-Type", "text/html");
        res.statusCode = 200;
        res.end(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Authorization Successful</title>
      <style>
        body { font-family: system-ui; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; }
        .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; }
        .key { background: #f4f4f4; padding: 15px; border-radius: 4px; word-break: break-all; font-family: monospace; margin: 15px 0; font-size: 12px; }
        button { background: #4CAF50; color: white; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; margin: 10px 5px; }
      </style>
    </head>
    <body>
      <div class="success">
        <h1>✅ Authorization Successful!</h1>
        ${
          payload
            ? `
          <div class="key">Encrypted Payload:<br>${payload.substring(
            0,
            100
          )}...</div>
          <p><strong>Copy this payload and use it in /api/auth/complete</strong></p>
          <button onclick="navigator.clipboard.writeText('${payload}').then(() => alert('Copied!'))">Copy Payload</button>
        `
            : '<p style="color:red;">No payload received!</p>'
        }
      </div>
    </body>
    </html>
  `);
        return;
      }

      // Route to plugin endpoints
      if (url.pathname.startsWith("/api/")) {
        try {
          // Read request body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body =
            chunks.length > 0
              ? JSON.parse(Buffer.concat(chunks).toString())
              : {};

          console.log(
            `\n[${new Date().toISOString()}] ${req.method} ${url.pathname}`
          );

          // Call client methods
          let result;

          if (url.pathname === "/api/auth/user-api-url") {
            result = await client.getUserApiAuthUrl(body);
          } else if (url.pathname === "/api/auth/complete") {
            result = await client.completeLink(body);
          } else if (url.pathname === "/api/posts/create") {
            result = await client.createPost(body);
          } else if (url.pathname === "/api/linkage/get") {
            result = await client.getLinkage(body);
          } else {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Endpoint not found" }));
            return;
          }

          // Send response
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify(result));
        } catch (error: any) {
          console.error("Error:", error);
          res.setHeader("Content-Type", "application/json");
          res.statusCode = error.status || 500;
          res.end(
            JSON.stringify({
              error: error.message || "Internal server error",
              code: error.code,
            })
          );
        }
      } else {
        res.statusCode = 404;
        res.end("Not found");
      }
    }
  );

  const PORT = process.env.PORT || 3001;

  server.listen(PORT, () => {
    console.log("✓ Plugin server started\n");
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log("\n📋 Setup Checklist:");
    console.log("  1. ✅ System API key configured");
    console.log("  2. ⚠️  Add callback URL to Discourse:");
    console.log(
      `     Admin → Settings → API → Allowed user API auth redirects`
    );
    console.log(`     Add: http://localhost:${PORT}/*`);
    console.log("\n🔌 Available endpoints:");
    console.log("  GET  /health                    - Health check");
    console.log("  POST /api/auth/user-api-url     - Get User API auth URL");
    console.log(
      "  POST /api/auth/complete         - Complete User API + NEAR link"
    );
    console.log("  POST /api/posts/create          - Create Discourse post");
    console.log(
      "  POST /api/linkage/get           - Check if account is linked"
    );
    console.log("\n💡 Using Discourse User API (simpler than OAuth2!)");
    console.log("\nPress Ctrl+C to stop\n");
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("\nShutting down...");
    server.close();
    await runtime.shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    server.close();
    await runtime.shutdown();
    process.exit(0);
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
