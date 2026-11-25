// Client for mega-client-worker — all MEGA operations go through the
// MEGA_CLIENT service binding. This worker never touches MEGA credentials
// or the megajs client directly.
//
// Route mapping (mega-client-worker):
//   state/<path>  GET/PUT  small JSON state files (pomodoro, websites, …)
//   stats         GET      folder usage under lumaris/
//   ping          GET      connection check
//   list/ read/ upload folder rename delete/   user files API

async function megaRequest(env, path, { method = "GET", body } = {}) {
  if (!env.MEGA_CLIENT) {
    throw new Error("MEGA_CLIENT service binding is not configured");
  }
  const headers = {};
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await env.MEGA_CLIENT.fetch(new Request(`https://mega.internal/${path}`, init));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `MEGA worker error (${res.status})`);
  }
  return data;
}

// --- Internal state files (small JSON/text under lumaris/) ---

export async function megaStateGet(env, path) {
  const data = await megaRequest(env, `state/${path}`);
  return data?.content ?? null;
}

export async function megaStatePut(env, path, value) {
  return await megaRequest(env, `state/${path}`, { method: "PUT", body: value });
}

// --- Stats & health ---

export async function megaStats(env, path = "files") {
  return await megaRequest(env, `stats?path=${encodeURIComponent(path)}`);
}

export async function megaPing(env) {
  return await megaRequest(env, "ping");
}

// --- User files API (proxied from /api/files/*) ---

export async function megaFilesProxy(env, subPath, method, body, headers) {
  const megaHeaders = new Headers();
  for (const h of ["content-type"]) {
    const v = headers?.get?.(h);
    if (v) megaHeaders.set(h, v);
  }

  const init = { method, headers: megaHeaders };
  if (method !== "GET" && method !== "HEAD") {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body ?? {});
      if (!megaHeaders.has("content-type")) {
        megaHeaders.set("Content-Type", "application/json");
      }
    }
  }

  const res = await env.MEGA_CLIENT.fetch(
    new Request(`https://mega.internal/${subPath || ""}`, init)
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `MEGA worker error (${res.status})`);
  }
  return data;
}
