/** v1.17: session (device) management — list, revoke one, revoke others. */

/** Turn a raw User-Agent into a short readable device label. */
export function uaLabel(ua) {
  if (!ua) return "未知设备";
  const s = String(ua);
  const os = /iPhone|iPad|iPod/.test(s)
    ? "iOS"
    : /Android/.test(s)
      ? "Android"
      : /Macintosh|Mac OS X/.test(s)
        ? "macOS"
        : /Windows/.test(s)
          ? "Windows"
          : /CrOS/.test(s)
            ? "ChromeOS"
            : /Linux/.test(s)
              ? "Linux"
              : "";
  const br = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /Firefox\//.test(s)
        ? "Firefox"
        : /Chrome\//.test(s)
          ? "Chrome"
          : /Safari\//.test(s)
            ? "Safari"
            : /curl\//i.test(s)
              ? "curl"
              : "浏览器";
  return os ? `${br} · ${os}` : br;
}

/** All live sessions of a user, newest activity first. */
export async function listSessions(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at
     FROM sessions WHERE user_id = ?
     ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC`,
  )
    .bind(userId)
    .all();
  return (results || []).map((s) => ({
    ...s,
    device: uaLabel(s.user_agent),
    active: s.expires_at ? new Date(s.expires_at).getTime() > Date.now() : false,
  }));
}

/** Revoke one session owned by `userId`. Returns true when a row was deleted. */
export async function revokeSession(env, userId, sessionId) {
  const res = await env.DB.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
    .bind(Number(sessionId), userId)
    .run();
  return (res.meta?.changes || 0) > 0;
}

/** Revoke every session of `userId` except the current one. */
export async function revokeOtherSessions(env, userId, currentSessionId) {
  const res = await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
    .bind(userId, Number(currentSessionId) || 0)
    .run();
  return res.meta?.changes || 0;
}
