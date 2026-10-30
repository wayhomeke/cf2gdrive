/**
 * Google Drive OAuth2 flow with PKCE and offline localhost redirect parsing.
 * Mirrors the frictionless sub2api / rclone desktop authorization pattern.
 */
import { getSetting, setSetting } from "./settings.js";
import { decryptSecret, encryptSecret } from "./crypto_vault.js";
import { getDriveUserInfo } from "./drive.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://localhost:8085/callback";
const SCOPE = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

/** URL-safe random string. */
function randomString(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Calculate PKCE S256 code_challenge from code_verifier. */
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate Google OAuth2 authorization URL with PKCE.
 * Stores code_verifier in D1 keyed by state.
 */
export async function generateAuthUrl(env) {
  const clientId = await getSetting(env, "gdrive_client_id");
  if (!clientId) {
    throw new Error("Client ID not configured. Please paste your client.json first.");
  }

  const state = randomString(24);
  const codeVerifier = randomString(32);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Cache verifier for 15 minutes in D1 settings
  const sessionData = JSON.stringify({
    verifier: codeVerifier,
    created_at: Date.now(),
  });
  await setSetting(env, `oauth_state_${state}`, sessionData);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  return {
    auth_url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
  };
}

/**
 * Parse code & state from pasted URL string or json, verify PKCE, exchange token,
 * encrypt and persist refresh_token in D1.
 */
export async function exchangeCallback(env, input) {
  const raw = String(input.callback_url || input.code || "").trim();
  if (!raw) throw new Error("No URL or authorization code provided");

  let code = "";
  let state = "";

  // If user pasted a full URL or query string like "http://localhost:8085/callback?state=...&code=..."
  if (raw.includes("code=")) {
    try {
      const u = new URL(raw.startsWith("http") ? raw : `http://localhost/${raw}`);
      code = u.searchParams.get("code") || "";
      state = u.searchParams.get("state") || "";
    } catch {
      const codeMatch = raw.match(/[?&]code=([^&]+)/);
      const stateMatch = raw.match(/[?&]state=([^&]+)/);
      code = codeMatch ? decodeURIComponent(codeMatch[1]) : "";
      state = stateMatch ? decodeURIComponent(stateMatch[1]) : "";
    }
  } else {
    code = raw;
    state = String(input.state || "").trim();
  }

  if (!code) throw new Error("Could not extract authorization code from input");

  let verifier = "";
  if (state) {
    const rawSession = await getSetting(env, `oauth_state_${state}`);
    if (rawSession) {
      try {
        const parsed = JSON.parse(rawSession);
        verifier = parsed.verifier;
      } catch {}
      // Clear state once used
      await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`oauth_state_${state}`).run();
    }
  }

  const clientId = await getSetting(env, "gdrive_client_id");
  const encSec = await getSetting(env, "gdrive_client_secret_enc");
  const clientSecret = encSec ? await decryptSecret(env.SESSION_SECRET, encSec) : "";

  if (!clientId || !clientSecret) {
    throw new Error("Client ID or Client Secret missing in database");
  }

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  if (verifier) {
    tokenParams.set("code_verifier", verifier);
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenParams,
  });

  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(j.error_description || j.error || `Google token exchange failed (HTTP ${resp.status})`);
  }

  if (!j.refresh_token) {
    throw new Error("Google did not return a refresh_token. Please visit Google consent screen and ensure 'prompt=consent' is used.");
  }

  // Encrypt refresh_token and store in D1
  const encRefreshToken = await encryptSecret(env.SESSION_SECRET, j.refresh_token);
  await setSetting(env, "gdrive_refresh_token_enc", encRefreshToken);

  // v2.39.0: record what Google actually granted. The token response echoes
  // the granted scope list; it can be a subset of what we asked for (e.g. a
  // restricted scope dropped because the consent screen never listed it),
  // which surfaces later as 403 "insufficient authentication scopes".
  await setSetting(env, "gdrive_granted_scope", String(j.scope || ""));

  // Fetch account profile info
  let email = "";
  let name = "";
  if (j.access_token) {
    const userInfo = await getDriveUserInfo(j.access_token);
    if (userInfo?.email) {
      email = userInfo.email;
      name = userInfo.name || "";
      await setSetting(env, "gdrive_account_email", email);
      if (userInfo.picture) await setSetting(env, "gdrive_account_picture", userInfo.picture);
    }
  }

  return {
    ok: true,
    email,
    name,
    expires_in: j.expires_in,
  };
}
