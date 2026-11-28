// Workflows
import { CheckGradesWorkflow } from "./workflows/check_grades.js";

// API features
// ÉcoleDirecte lives in ed-client-worker and MEGA storage in
// mega-client-worker, both reached through service bindings — this worker
// only proxies /api/ed/* and /api/files/* requests to them.
import { AIfunction } from "./backend/ai/index.js";
import { Cache } from "./backend/cache/index.js";
import { Auth } from "./backend/auth/index.js";
import { verifySessionToken } from "./backend/auth/session.js";
import { Pomodoro } from "./backend/database/pomodoro.js";
import { WebsitesFunction } from "./backend/database/websites.js";
import { megaFilesProxy } from "./backend/mega_client.js";
import { StorageFunction, registerFile, removeFileByPath, renameFileRow } from "./backend/storage/index.js";
import { TasksFunction } from "./backend/database/tasks.js";
import { SubjectsFunction } from "./backend/database/subjects.js";
import { DumpFunction } from "./backend/database/dump.js";
import { LearningFunction } from "./backend/learning/index.js";
import { ToolsFunction } from "./backend/tools/index.js";
import { StatsFunction } from "./backend/settings/stats.js";
import { CustomizationFunction } from "./backend/settings/customization.js";
  
import { sendMail } from "./backend/notifications/mail.js";

// Keep the storage D1 `files` table in sync with MEGA operations.
// files.id = MEGA node ID — the value referenced by attachments_id.
async function syncFilesTable(env, sub, method, body, resp) {
  try {
    if (method === "POST" && sub === "upload" && resp?.nodeId) {
      const relativePath = body instanceof FormData ? body.get("relativePath") : body?.relativePath;
      if (relativePath) {
        await registerFile(env, {
          id: resp.nodeId,
          path: `files/${relativePath}`,
          name: resp.name || relativePath.split("/").pop(),
          size: resp.size,
        });
      }
    } else if (method === "DELETE" && sub.startsWith("delete/")) {
      const relativePath = decodeURIComponent(sub.slice("delete/".length));
      await removeFileByPath(env, `files/${relativePath}`);
    } else if (method === "POST" && sub === "rename" && body?.oldPath && body?.newName) {
      const oldFull = `files/${body.oldPath}`;
      const dir = body.oldPath.includes("/") ? body.oldPath.slice(0, body.oldPath.lastIndexOf("/")) : "";
      const newFull = dir ? `${dir}/${body.newName}` : body.newName;
      await renameFileRow(env, oldFull, `files/${newFull}`, body.newName);
    }
  } catch (e) {
    console.error("syncFilesTable failed:", e?.message || e);
  }
}

async function sendErrorEmail(env, error, context) {
  try {
    const rawError = error instanceof Error ? error.stack || error.message : String(error);
    await sendMail(env, {
      subject: `Dashboard error: ${context}`,
      text: `A runtime error occurred while processing the request in the Dashboard application.\n\nContext: ${context}\n\nRaw error:\n${rawError}`,
    });
  } catch (mailError) {
    console.error("Failed to send error email:", mailError);
  }
}

// API funtion
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const headers = request.headers
    let body;
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('multipart/form-data')) {
      // Handle FormData (file upload)
      const formData = await request.formData();
      body = formData;
    } else {
      // Handle JSON
      try {
        body = JSON.parse(await request.text());
      } catch (e) {
        body = {};
      }
    } 
    
    // =========================
    // 📶 MAIN API
    // =========================
    /// CORS
    const corsHeaders = {
      "Content-Type":
        "application/json",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, PUT, PATCH, OPTIONS",

      "Access-Control-Allow-Headers":
        "*"
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    // Auth: exchange one-time token for JWT via authentication-client-worker
    if (url.pathname === "/api/auth/exchange" && method === "POST") {
      try {
        const resp = await Auth(env, "exchange", method, body, request);
        return new Response(JSON.stringify(resp), { headers: corsHeaders });
      } catch (e) {
        console.error("AUTH EXCHANGE ERROR:", e?.stack || e);
        return new Response(JSON.stringify({ valid: false, error: e?.message }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname === "/api/auth/verify-jwt" && method === "POST") {
      try {
        const resp = await Auth(env, "verify-jwt", method, body, request);
        return new Response(JSON.stringify(resp), { headers: corsHeaders });
      } catch (e) {
        console.error("JWT VERIFY ERROR:", e?.stack || e);
        return new Response(JSON.stringify({ valid: false, error: e?.message }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    if (url.pathname === "/api/auth/invalidate" && method === "POST") {
      await caches.default.delete(new Request("https://cache/session_tokens"));
      return new Response(JSON.stringify({ invalidated: true }), { headers: corsHeaders });
    }

    if (url.pathname.startsWith("/api/auth/")) {
      try {
        const resp = await Auth(env, url.pathname.slice("/api/auth/".length), method, body, request);
        return new Response(JSON.stringify(resp), { headers: corsHeaders });
      } catch (e) {
        console.error("AUTH ERROR:", e?.stack || e);
        await sendErrorEmail(env, e, "AUTH");
        return new Response(JSON.stringify({ valid: false, error: e?.message }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }


    if (url.pathname.startsWith("/api/")) {
      // Every data route requires a valid JWT in the Authorization header.
      // /api/auth/* are intentionally reachable without one (they bootstrap the login + token exchange).
      const authHeader = headers.get("Authorization") || "";
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
      const session = await verifySessionToken(env, bearer);
      if (!session.valid) {
        return new Response(JSON.stringify({ error: "unauthorized", reason: session.reason }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      try {
        // Ecole directe paths → proxied to ed-client-worker via service binding
        let resp;
        if (url.pathname.startsWith("/api/ed/")) {
          if (!env.ED_CLIENT) throw new Error("ED_CLIENT service binding is not configured");
          const sub = url.pathname.slice("/api/ed/".length);
          const edHeaders = new Headers();
          for (const h of ["filter", "new_token", "new-token", "content-type"]) {
            const v = headers.get(h);
            if (v) edHeaders.set(h, v);
          }
          const edRes = await env.ED_CLIENT.fetch(new Request(`https://ed.internal/${sub}`, {
            method,
            headers: edHeaders,
            body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}),
          }));
          const edData = await edRes.json().catch(() => ({}));
          if (!edRes.ok) throw new Error(edData?.error || `ED worker error (${edRes.status})`);
          resp = edData;
        } else if (url.pathname.startsWith("/api/files/")) {
          // Files live in mega-client-worker via the MEGA_CLIENT binding;
          // the storage D1 keeps the lightweight metadata (id = MEGA node ID)
          if (!env.MEGA_CLIENT) throw new Error("MEGA_CLIENT service binding is not configured");
          const sub = url.pathname.slice("/api/files/".length);
          resp = await megaFilesProxy(env, sub, method, body, headers);
          await syncFilesTable(env, sub, method, body, resp);
        } else if (url.pathname.startsWith("/api/storage/")) {
          resp = await StorageFunction(env, url.pathname.slice("/api/storage/".length), method, body);
        } else if (url.pathname.startsWith("/api/ai/")) {
          resp = await AIfunction(env, url.pathname.slice("/api/ai/".length), method, headers, body, request);
        } else if (url.pathname.startsWith("/api/pomodoro/")) {
          resp = await Pomodoro(env, url.pathname.slice("/api/pomodoro/".length), method, body);
        } else if (url.pathname.startsWith("/api/websites/")) {
          resp = await WebsitesFunction(env, url.pathname.slice("/api/websites/".length), method, body);
        } else if (url.pathname.startsWith("/api/tools/")) {
          resp = await ToolsFunction(env, url.pathname.slice("/api/tools/".length), method, body);
        } else if (url.pathname === "/api/dump" || url.pathname === "/api/dump/") {
          resp = await DumpFunction(env, method);
        } else if (url.pathname === "/api/settings/stats" || url.pathname === "/api/settings/stats/") {
          resp = await StatsFunction(env);
        } else if (url.pathname === "/api/settings/customization" || url.pathname === "/api/settings/customization/") {
          resp = await CustomizationFunction(env, url.pathname.slice("/api/settings/customization".length), method, body, session.payload);
        } else if (url.pathname === "/api/tasks" || url.pathname === "/api/tasks/" || url.pathname.startsWith("/api/tasks/")) {
          resp = await TasksFunction(env, url.pathname.slice("/api/tasks/".length), method, body, session.payload);
        } else if (url.pathname === "/api/subjects" || url.pathname === "/api/subjects/" || url.pathname.startsWith("/api/subjects/")) {
          resp = await SubjectsFunction(env, url.pathname.slice("/api/subjects/".length), method, body);
        } else if (url.pathname === "/api/learning" || url.pathname === "/api/learning/" || url.pathname.startsWith("/api/learning/")) {
          resp = await LearningFunction(env, url.pathname.slice("/api/learning/".length), method, body);
        };
        // Return response
        return new Response(JSON.stringify({
          resp
        }), {
          headers: corsHeaders
        })
      } catch (e) {
        console.error("API ERROR:", e?.stack || e);
        // await sendErrorEmail(env, e, `API ${url.pathname}`);
        return new Response(JSON.stringify({
          error: e?.message,
        }), {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Déclencher le workflow check_grades
    try {
      await env.CHECK_GRADES.create();
    } catch (error) {
      console.error("Error triggering check_grades workflow:", error);
    }
  }
}

// Export the workflows code
export { CheckGradesWorkflow };
