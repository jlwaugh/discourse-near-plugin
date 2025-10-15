import { createPlugin, CommonPluginErrors } from "every-plugin";
import { Effect } from "every-plugin/effect";
import { oc, implement } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import { verify, parseAuthToken } from "near-sign-verify";
import { randomBytes, generateKeyPairSync } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

// ============================================================================
// SCHEMAS
// ============================================================================

const contract = oc.router({
  // Step 1: Get User API auth URL
  getUserApiAuthUrl: oc
    .route({ method: "POST", path: "/auth/user-api-url" })
    .input(
      z.object({
        clientId: z.string(),
        applicationName: z.string(),
      })
    )
    .output(
      z.object({
        authUrl: z.string().url(),
        nonce: z.string(),
      })
    )
    .errors(CommonPluginErrors),

  // Step 2: Complete auth with encrypted payload and link NEAR account
  completeLink: oc
    .route({ method: "POST", path: "/auth/complete" })
    .input(
      z.object({
        payload: z.string(), // Encrypted payload from Discourse (base64)
        nonce: z.string(),
        authToken: z.string(), // NEAR signature
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        nearAccount: z.string(),
        discourseUsername: z.string(),
        message: z.string(),
      })
    )
    .errors(CommonPluginErrors),

  // Step 3: Create Discourse post
  createPost: oc
    .route({ method: "POST", path: "/posts/create" })
    .input(
      z.object({
        authToken: z.string(),
        title: z.string().min(15),
        raw: z.string().min(20),
        category: z.number().optional(),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        postUrl: z.string().optional(),
        postId: z.number().optional(),
        topicId: z.number().optional(),
        error: z.string().optional(),
      })
    )
    .errors(CommonPluginErrors),

  // Get linkage info
  getLinkage: oc
    .route({ method: "POST", path: "/linkage/get" })
    .input(z.object({ nearAccount: z.string() }))
    .output(
      z
        .object({
          nearAccount: z.string(),
          discourseUsername: z.string(),
          verifiedAt: z.string(),
        })
        .nullable()
    )
    .errors(CommonPluginErrors),
});

// ============================================================================
// DISCOURSE CLIENT
// ============================================================================

class DiscourseClient {
  constructor(
    private baseUrl: string,
    private systemApiKey: string,
    private systemUsername: string
  ) {}

  getUserApiAuthUrl(params: {
    clientId: string;
    applicationName: string;
    nonce: string;
    publicKey: string;
    scopes: string[];
  }): string {
    // URL encode the public key manually
    const publicKeyEncoded = encodeURIComponent(params.publicKey);

    const queryParams = [
      `client_id=${encodeURIComponent(params.clientId)}`,
      `application_name=${encodeURIComponent(params.applicationName)}`,
      `nonce=${encodeURIComponent(params.nonce)}`,
      `scopes=${encodeURIComponent(params.scopes.join(","))}`,
      `public_key=${publicKeyEncoded}`,
    ].join("&");

    return `${this.baseUrl}/user-api-key/new?${queryParams}`;
  }

  async getCurrentUser(userApiKey: string): Promise<{
    id: number;
    username: string;
    name: string;
    [key: string]: any;
  }> {
    const response = await fetch(`${this.baseUrl}/session/current.json`, {
      headers: {
        "User-Api-Key": userApiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get current user: ${response.status} - ${error}`
      );
    }

    const data = await response.json();
    return (data as { current_user: any }).current_user;
  }

  async createPost(params: {
    title: string;
    raw: string;
    category?: number;
    username: string;
  }): Promise<{
    id: number;
    topic_id: number;
    topic_slug: string;
    [key: string]: any;
  }> {
    const response = await fetch(`${this.baseUrl}/posts.json`, {
      method: "POST",
      headers: {
        "Api-Key": this.systemApiKey,
        "Api-Username": params.username,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: params.title,
        raw: params.raw,
        category: params.category,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Discourse API error: ${response.status} - ${error}`);
    }

    return (await response.json()) as {
      id: number;
      topic_id: number;
      topic_slug: string;
      [key: string]: any;
    };
  }
}

// ============================================================================
// STORAGE
// ============================================================================

interface Linkage {
  nearAccount: string;
  discourseUsername: string;
  discourseUserId: number;
  userApiKey: string; // Store the User API key for this user
  verifiedAt: string;
}

class LinkageStore {
  private linkages = new Map<string, Linkage>();

  set(nearAccount: string, linkage: Linkage) {
    this.linkages.set(nearAccount, linkage);
    console.log(
      `[LinkageStore] Stored: ${nearAccount} → ${linkage.discourseUsername}`
    );
  }

  get(nearAccount: string): Linkage | null {
    const linkage = this.linkages.get(nearAccount) || null;
    console.log(
      `[LinkageStore] Get ${nearAccount}:`,
      linkage ? "Found" : "Not found"
    );
    return linkage;
  }

  getAll(): Linkage[] {
    return Array.from(this.linkages.values());
  }
}

// ============================================================================
// NONCE MANAGER (with private key storage)
// ============================================================================

interface NonceData {
  nonce: string;
  clientId: string;
  privateKey: string;
  timestamp: number;
}

class NonceManager {
  private nonces = new Map<string, NonceData>();
  private readonly NONCE_TTL = 10 * 60 * 1000; // 10 minutes

  create(clientId: string, privateKey: string): string {
    const nonce = randomBytes(32).toString("hex");

    this.nonces.set(nonce, {
      nonce,
      clientId,
      privateKey,
      timestamp: Date.now(),
    });

    console.log(`[NonceManager] Created nonce: ${nonce.substring(0, 8)}...`);
    return nonce;
  }

  verify(nonce: string, clientId: string): boolean {
    const data = this.nonces.get(nonce);

    if (!data) {
      console.log(
        `[NonceManager] Nonce not found: ${nonce.substring(0, 8)}...`
      );
      return false;
    }

    if (Date.now() - data.timestamp > this.NONCE_TTL) {
      this.nonces.delete(nonce);
      console.log(`[NonceManager] Nonce expired: ${nonce.substring(0, 8)}...`);
      return false;
    }

    if (data.clientId !== clientId) {
      console.log(`[NonceManager] Client ID mismatch for nonce`);
      return false;
    }

    return true;
  }

  getPrivateKey(nonce: string): string | null {
    const data = this.nonces.get(nonce);
    return data?.privateKey || null;
  }

  consume(nonce: string): void {
    this.nonces.delete(nonce);
    console.log(`[NonceManager] Consumed nonce: ${nonce.substring(0, 8)}...`);
  }

  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [nonce, data] of this.nonces.entries()) {
      if (now - data.timestamp > this.NONCE_TTL) {
        this.nonces.delete(nonce);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[NonceManager] Cleaned up ${cleaned} expired nonces`);
    }
  }
}

// ============================================================================
// PLUGIN
// ============================================================================

export default createPlugin({
  id: "discourse-near",
  contract,

  variables: z.object({
    discourseBaseUrl: z.string().url(),
    discourseApiUsername: z.string().default("system"),
    applicationName: z.string().default("NEAR Account Link"),
    clientId: z.string().default("discourse-near-plugin"),
    recipient: z.string().default("social.near"),
  }),

  secrets: z.object({
    discourseApiKey: z.string().min(1),
  }),

  initialize: (config) =>
    Effect.gen(function* () {
      console.log("[Plugin] Initializing...");
      console.log(
        `[Plugin] Discourse URL: ${config.variables.discourseBaseUrl}`
      );
      console.log(`[Plugin] Application: ${config.variables.applicationName}`);

      const discourseClient = new DiscourseClient(
        config.variables.discourseBaseUrl,
        config.secrets.discourseApiKey,
        config.variables.discourseApiUsername
      );

      const linkageStore = new LinkageStore();
      const nonceManager = new NonceManager();

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("5 minutes");
            nonceManager.cleanup();
          }
        })
      );

      console.log("[Plugin] Initialized successfully");

      return {
        discourseClient,
        linkageStore,
        nonceManager,
        applicationName: config.variables.applicationName,
        clientId: config.variables.clientId,
        baseUrl: config.variables.discourseBaseUrl,
        recipient: config.variables.recipient,
      };
    }),

  createRouter: (context) => {
    const os = implement(contract).$context<typeof context>();

    return os.router({
      getUserApiAuthUrl: os.getUserApiAuthUrl.handler(async ({ input }) => {
        console.log("[getUserApiAuthUrl] Generating User API auth URL...");

        // Generate RSA key pair
        const { publicKey, privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: {
            type: "spki",
            format: "pem",
          },
          privateKeyEncoding: {
            type: "pkcs8",
            format: "pem",
          },
        });

        console.log("[getUserApiAuthUrl] Generated RSA key pair");

        const nonce = context.nonceManager.create(input.clientId, privateKey);

        const authUrl = context.discourseClient.getUserApiAuthUrl({
          clientId: input.clientId,
          applicationName: input.applicationName,
          nonce: nonce,
          publicKey: publicKey,
          scopes: ["read", "write"],
        });

        console.log("[getUserApiAuthUrl] Auth URL generated");
        return {
          authUrl,
          nonce,
        };
      }),

      completeLink: os.completeLink.handler(async ({ input, errors }) => {
        console.log("[completeLink] Starting link completion...");

        let tempKeyPath: string | null = null;

        try {
          // Verify nonce
          if (!context.nonceManager.verify(input.nonce, context.clientId)) {
            throw errors.BAD_REQUEST({
              message: "Invalid or expired nonce",
              data: {},
            });
          }

          console.log("[completeLink] Nonce verified");

          // Get private key
          const privateKey = context.nonceManager.getPrivateKey(input.nonce);
          if (!privateKey) {
            throw errors.BAD_REQUEST({
              message: "Private key not found",
              data: {},
            });
          }

          // Decrypt payload using OpenSSL shell script
          console.log("[completeLink] Decrypting payload...");

          // Write private key to temp file
          tempKeyPath = join(process.cwd(), `.temp-key-${input.nonce}.pem`);
          writeFileSync(tempKeyPath, privateKey);

          // Use the shell script instead of Node.js
          const { stdout, stderr } = await execAsync(
            `chmod +x ./src/decrypt.sh && ./src/decrypt.sh "${tempKeyPath}" "${input.payload}"`
          );

          // Clean up temp file
          unlinkSync(tempKeyPath);
          tempKeyPath = null;

          if (stderr) {
            console.error("[completeLink] Decryption stderr:", stderr);
          }

          if (!stdout || stdout.trim().length === 0) {
            throw new Error("Failed to decrypt payload: empty result");
          }

          // Parse the decrypted JSON
          const decryptedData = JSON.parse(stdout.trim());
          const userApiKey = decryptedData.key;

          console.log("[completeLink] Payload decrypted successfully");

          // Get Discourse user info using the User API key
          console.log("[completeLink] Getting Discourse user info...");
          const discourseUser = await context.discourseClient.getCurrentUser(
            userApiKey
          );

          console.log(
            "[completeLink] Discourse user verified:",
            discourseUser.username
          );

          // Verify NEAR signature
          console.log("[completeLink] Verifying NEAR signature...");
          const nearResult = await verify(input.authToken, {
            expectedRecipient: context.recipient, // social.near
            nonceMaxAge: 600000,
          });

          console.log(
            "[completeLink] NEAR signature verified:",
            nearResult.accountId
          );

          // Store linkage with User API key
          context.linkageStore.set(nearResult.accountId, {
            nearAccount: nearResult.accountId,
            discourseUsername: discourseUser.username,
            discourseUserId: discourseUser.id,
            userApiKey: userApiKey,
            verifiedAt: new Date().toISOString(),
          });

          context.nonceManager.consume(input.nonce);

          console.log("[completeLink] Link successful!");

          return {
            success: true,
            nearAccount: nearResult.accountId,
            discourseUsername: discourseUser.username,
            message: `Successfully linked ${nearResult.accountId} to ${discourseUser.username}`,
          };
        } catch (error: any) {
          // Clean up temp file on error
          if (tempKeyPath) {
            try {
              unlinkSync(tempKeyPath);
            } catch {}
          }

          console.error("[completeLink] Error:", error.message);
          console.error("[completeLink] Full error:", error);

          if (error && typeof error === "object" && "code" in error) {
            throw error;
          }

          throw errors.BAD_REQUEST({
            message: error.message || "Link completion failed",
            data: {},
          });
        }
      }),

      createPost: os.createPost.handler(async ({ input, errors }) => {
        console.log("[createPost] Starting post creation...");

        try {
          const result = await verify(input.authToken, {
            expectedRecipient: context.recipient,
            nonceMaxAge: 300000,
          });

          const linkage = context.linkageStore.get(result.accountId);
          if (!linkage) {
            throw errors.FORBIDDEN({
              message:
                "No linked Discourse account found. Please link your account first.",
              data: {
                requiredPermissions: ["linked-account"],
                action: "create-post",
              },
            });
          }

          console.log(
            "[createPost] Creating post as:",
            linkage.discourseUsername
          );

          const postData = await context.discourseClient.createPost({
            title: input.title,
            raw: input.raw,
            category: input.category,
            username: linkage.discourseUsername,
          });

          console.log("[createPost] Post created! ID:", postData.id);

          return {
            success: true,
            postUrl: `${context.baseUrl}/t/${postData.topic_slug}/${postData.topic_id}`,
            postId: postData.id,
            topicId: postData.topic_id,
          };
        } catch (error: any) {
          console.error("[createPost] Error:", error.message);

          if (error && typeof error === "object" && "code" in error) {
            throw error;
          }

          let errorMessage = error.message || "Failed to create post";
          if (error.message?.includes("You are not permitted")) {
            errorMessage =
              "You do not have permission to post in this category";
          } else if (error.message?.includes("Body is too short")) {
            errorMessage = "Post content is too short";
          } else if (error.message?.includes("Title is too short")) {
            errorMessage = "Title is too short (minimum 15 characters)";
          }

          return {
            success: false,
            error: errorMessage,
          };
        }
      }),

      getLinkage: os.getLinkage.handler(async ({ input }) => {
        console.log("[getLinkage] Checking linkage for:", input.nearAccount);
        const linkage = context.linkageStore.get(input.nearAccount);

        if (linkage) {
          console.log("[getLinkage] Found:", linkage.discourseUsername);
          // Don't expose the User API key
          return {
            nearAccount: linkage.nearAccount,
            discourseUsername: linkage.discourseUsername,
            verifiedAt: linkage.verifiedAt,
          };
        } else {
          console.log("[getLinkage] Not found");
        }

        return linkage;
      }),
    });
  },
});
