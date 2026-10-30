/** v1.18: append-only audit log. Writes are best-effort and never block a response. */

/** Insert one audit row. Pass `ctx` to run it off the response path. */
export function logAudit(env, ctx, entry) {
  const row = {
    user_id: entry.userId ?? null,
    actor_email: (entry.email || "").slice(0, 200) || null,
    action: String(entry.action || "unknown").slice(0, 60),
    target: entry.target != null ? String(entry.target).slice(0, 120) : null,
    detail: (entry.detail || "").slice(0, 300) || null,
    ip: (entry.ip || "").slice(0, 60) || null,
  };
  const run = () =>
    env.DB.prepare(
      `INSERT INTO audit_log (user_id, actor_email, action, target, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(row.user_id, row.actor_email, row.action, row.target, row.detail, row.ip)
      .run()
      .catch(() => {
        // auditing must never break the request
      });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run());
  else return run();
}

/** Shared dynamic WHERE for the audit listing. Every value is bound, never interpolated. */
function auditWhere({ action = "", userId = "", q = "" } = {}) {
  let where = "1 = 1";
  const binds = [];
  if (action) {
    where += " AND action = ?";
    binds.push(action);
  }
  if (userId) {
    where += " AND user_id = ?";
    binds.push(Number(userId));
  }
  if (q) {
    const like = `%${String(q).replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    where += " AND (actor_email LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')";
    binds.push(like, like, like);
  }
  return { where, binds };
}

function normPaging({ page = 1, perPage = 50 } = {}) {
  return {
    page: Math.max(1, parseInt(page, 10) || 1),
    perPage: Math.min(200, Math.max(1, parseInt(perPage, 10) || 50)),
  };
}

/**
 * v1.20: the listing is one prepared statement — COUNT(*) OVER () carries the
 * total, so the common path costs a single D1 round trip instead of two.
 */
export function auditListStatement(env, opts = {}) {
  const { where, binds } = auditWhere(opts);
  const { page, perPage } = normPaging(opts);
  return env.DB.prepare(
    `SELECT id, user_id, actor_email, action, target, detail, ip, created_at,
            COUNT(*) OVER () AS total_count
     FROM audit_log WHERE ${where}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, perPage, (page - 1) * perPage);
}

/** Row count for the same filters (only needed when a page comes back empty). */
export function auditCountStatement(env, opts = {}) {
  const { where, binds } = auditWhere(opts);
  return env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${where}`).bind(...binds);
}

export function auditActionsStatement(env) {
  return env.DB.prepare("SELECT action, COUNT(*) AS c FROM audit_log GROUP BY action ORDER BY action");
}

/** Shape a D1Result from auditListStatement into the page model. */
export function auditResultShape(res, opts = {}) {
  const rows = res?.results || [];
  const { page, perPage } = normPaging(opts);
  const total = rows.length ? rows[0].total_count : 0;
  // An empty page past the end hides the total from the window function;
  // the caller can fill it in with auditCountStatement.
  const unknown = rows.length === 0 && page > 1;
  return {
    rows,
    total,
    page,
    perPage,
    unknown,
    pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Paginated audit listing. Filters: action (exact), userId (actor), q (keyword). */
export async function listAudit(env, opts = {}) {
  const data = auditResultShape(await auditListStatement(env, opts).all(), opts);
  if (data.unknown) {
    const row = await auditCountStatement(env, opts).first();
    data.total = row?.c || 0;
    data.pages = Math.max(1, Math.ceil(data.total / data.perPage));
    data.unknown = false;
  }
  return data;
}

/** Distinct action names present in the log (for the filter dropdown). */
export async function auditActions(env) {
  const { results } = await auditActionsStatement(env).all();
  return results || [];
}

/** Human label for an action code. */
export const AUDIT_LABELS = {
  login: "登录",
  login_failed: "登录失败",
  logout: "退出登录",
  register: "注册",
  upload: "上传图片",
  "relay.upload": "上传中转文件",
  "relay.delete": "删除中转文件",
  "relay.restore": "恢复中转文件",
  "relay.purge": "彻底删除中转文件",
  "relay.rename": "重命名中转文件",
  "relay.share": "分享中转文件",
  delete: "删除图片",
  restore: "恢复图片",
  purge: "彻底删除",
  share_create: "创建分享",
  share_revoke: "吊销分享",
  key_create: "创建 API 密钥",
  key_revoke: "吊销 API 密钥",
  session_revoke: "注销设备",
  session_revoke_others: "注销其他设备",
  profile_update: "修改资料",
  password_change: "修改密码",
  "admin.settings": "修改全局设置",
  "admin.quota": "修改用户配额",
  "admin.user_disable": "禁用用户",
  "admin.user_enable": "启用用户",
  "admin.user_delete": "删除用户",
  "admin.invite_create": "生成邀请码",
  "admin.invite_revoke": "吊销邀请码",
  "admin.trash_sweep": "清理回收站",
  "admin.storage_recount": "重算分片计数",
  "admin.storage_migrate": "整理分片存储",
};

export function auditLabel(action) {
  return AUDIT_LABELS[action] || action;
}
