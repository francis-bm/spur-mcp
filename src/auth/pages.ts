/**
 * Server-rendered sign-in pages for the OAuth authorize step.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string);

interface PageOptions {
  clientName: string;
  error?: string;
  /** Offer "Continue with Google" (only when the server has Supabase configured) */
  google?: boolean;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; --accent:#2563eb; --danger:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0f17; --card:#121826; --text:#f3f4f6; --muted:#9ca3af; --border:#1f2937; --accent:#60a5fa; --danger:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:16px; }
  main { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:28px; }
  .brand { font-weight:700; font-size:20px; letter-spacing:-.01em; }
  p { color:var(--muted); margin:6px 0 20px; }
  label { display:block; font-size:13px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--text); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { margin-top:20px; width:100%; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  .error { color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, transparent); padding:10px 12px; border-radius:8px; font-size:14px; }
  .fine { font-size:12px; margin-top:16px; margin-bottom:0; }
  .google { display:flex; align-items:center; justify-content:center; gap:10px; padding:10px; border:1px solid var(--border); border-radius:8px;
            color:var(--text); text-decoration:none; font-weight:600; }
  .google:hover { background:color-mix(in srgb, var(--text) 5%, transparent); }
  .google:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .divider { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:13px; margin:18px 0 0; }
  .divider::before, .divider::after { content:""; flex:1; border-top:1px solid var(--border); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const googleLogo = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

export function loginPage(authRequest: string, { clientName, error, google }: PageOptions): string {
  return layout(
    "Sign in to Spur",
    `<div class="brand">Spur</div>
<p><strong>${escapeHtml(clientName)}</strong> wants to access your Spur account: properties, owners, lists, outreach and direct mail.</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
${google ? `<a class="google" href="/oauth/google?req=${encodeURIComponent(authRequest)}">${googleLogo}Continue with Google</a>
<div class="divider">or sign in with email</div>` : ""}
<form method="post" action="/oauth/authorize" autocomplete="on">
  <input type="hidden" name="req" value="${escapeHtml(authRequest)}" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autofocus autocomplete="username" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password" />
  <button type="submit">Sign in and allow</button>
</form>
<p class="fine">Actions that spend money or contact people (mail, SMS, skip tracing) will always ask you first.</p>`
  );
}

export function mfaPage(authRequest: string, challenge: string, method: string, { clientName, error }: PageOptions): string {
  const hint = method === "totp" ? "Enter the code from your authenticator app." : `Enter the code we sent by ${escapeHtml(method)}.`;
  return layout(
    "Verify sign-in",
    `<div class="brand">Spur</div>
<p>Two-step verification for <strong>${escapeHtml(clientName)}</strong>. ${hint}</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="req" value="${escapeHtml(authRequest)}" />
  <input type="hidden" name="mfa" value="${escapeHtml(challenge)}" />
  <label for="code">Verification code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="10" required autofocus />
  <button type="submit">Verify</button>
</form>`
  );
}

export function errorPage(message: string): string {
  return layout("Spur sign-in error", `<div class="brand">Spur</div><p class="error" role="alert">${escapeHtml(message)}</p>`);
}
