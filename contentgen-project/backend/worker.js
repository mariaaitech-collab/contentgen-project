/**
 * LinkedIn OAuth + Posting backend — runs on Cloudflare Workers (free tier).
 *
 * Routes:
 *   GET  /auth/linkedin            -> redirects the user to LinkedIn's login screen
 *   GET  /auth/linkedin/callback   -> LinkedIn redirects back here after login
 *   GET  /api/linkedin/status      -> tells the front end if the user is connected
 *   POST /api/linkedin/post        -> actually publishes a post to LinkedIn
 *
 * Secrets needed (set with `wrangler secret put NAME`, never hard-code them):
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *
 * KV namespace needed (create with `wrangler kv namespace create SESSIONS`):
 *   SESSIONS  -> stores { accessToken, personUrn } per session id
 *
 * Update wrangler.toml with your worker's own subdomain, then set that
 * exact URL + "/auth/linkedin/callback" as the Authorized redirect URL
 * in your LinkedIn app's Auth tab.
 */

const REDIRECT_PATH = "/auth/linkedin/callback";

// CHANGE THIS to your actual front-end origin once you know it
// (e.g. "https://yourname.github.io" or "http://localhost:3000" while testing)
const ALLOWED_ORIGIN = "*"; // tighten this before going live

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };
}

function randomId() {
  return crypto.randomUUID();
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // ---- Step 1: kick off LinkedIn login ----
    if (url.pathname === "/auth/linkedin") {
      const redirectUri = `${url.origin}${REDIRECT_PATH}`;
      const state = randomId();

      const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "openid profile w_member_social");
      authUrl.searchParams.set("state", state);

      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl.toString(),
          "Set-Cookie": `li_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // ---- Step 2: LinkedIn sends the user back here ----
    if (url.pathname === REDIRECT_PATH) {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const savedState = getCookie(request, "li_oauth_state");

      if (!code || !state || state !== savedState) {
        return new Response("Login failed or expired. Please try connecting again.", { status: 400 });
      }

      const redirectUri = `${url.origin}${REDIRECT_PATH}`;

      // Exchange the temporary code for a real access token
      const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return new Response("Token exchange failed: " + errText, { status: 500 });
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      // Get the user's LinkedIn person URN (needed to author posts)
      const userRes = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userData = await userRes.json();
      const personUrn = `urn:li:person:${userData.sub}`;

      // Save the session
      const sessionId = randomId();
      await env.SESSIONS.put(
        sessionId,
        JSON.stringify({ accessToken, personUrn, name: userData.name }),
        { expirationTtl: 60 * 60 * 24 * 30 } // 30 days
      );

      // Send the user back to your front end, now "connected"
      // CHANGE THIS to your actual front-end URL
      const frontEndUrl = "https://mariaaitech-collab.github.io/contentgen-project/";

      return new Response(null, {
        status: 302,
        headers: {
          Location: frontEndUrl,
          "Set-Cookie": `li_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }

    // ---- Check connection status ----
    if (url.pathname === "/api/linkedin/status") {
      const sessionId = getCookie(request, "li_session");
      if (!sessionId) {
        return new Response(JSON.stringify({ connected: false }), {
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }
      const session = await env.SESSIONS.get(sessionId, "json");
      return new Response(JSON.stringify({ connected: !!session, name: session?.name }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    // ---- Step 3: actually post ----
    if (url.pathname === "/api/linkedin/post" && request.method === "POST") {
      const sessionId = getCookie(request, "li_session");
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "Not connected" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      const session = await env.SESSIONS.get(sessionId, "json");
      if (!session) {
        return new Response(JSON.stringify({ error: "Session expired, please reconnect" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      const { content } = await request.json();
      if (!content || !content.trim()) {
        return new Response(JSON.stringify({ error: "No content provided" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      const postRes = await fetch("https://api.linkedin.com/rest/posts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          "LinkedIn-Version": "202406",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: session.personUrn,
          commentary: content,
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        return new Response(JSON.stringify({ error: "LinkedIn rejected the post", details: errText }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders() },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
