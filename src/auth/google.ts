/**
 * "Continue with Google" for the sign-in page. Spur's web app signs Google users in through Supabase
 * Auth, so we run the same Supabase OAuth flow (PKCE, server-side) and hand the Supabase user to
 * Spur's /api/auth/oauth/callback, which links or creates the Spur account and returns Spur JWTs.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

export interface SupabaseUser {
  id: string;
  email?: string;
  app_metadata?: { provider?: string };
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string };
}

export const googleEnabled = () => Boolean(config.supabaseUrl && config.supabaseAnonKey);

export const googleCallbackUrl = () => `${config.publicUrl}/oauth/google/callback`;

/** Supabase's /authorize URL; it bounces through Google and comes back to us with ?code= */
export function googleAuthorizeUrl(codeVerifier: string): string {
  const url = new URL(`${config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", googleCallbackUrl());
  url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

/** Swaps the Supabase auth code for a Supabase session; null when Supabase rejects it */
export async function exchangeGoogleCode(authCode: string, codeVerifier: string): Promise<{ accessToken: string; user: SupabaseUser } | null> {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", apikey: config.supabaseAnonKey },
    body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) return null;
  const session = (await response.json().catch(() => ({}))) as { access_token?: string; user?: SupabaseUser };
  return session.access_token && session.user?.id ? { accessToken: session.access_token, user: session.user } : null;
}
