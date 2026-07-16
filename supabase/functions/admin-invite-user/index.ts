import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData?.user) {
      return json({ error: "Invalid session" }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: callerPerson, error: callerError } = await adminClient
      .from("people")
      .select("id, access_level, is_active")
      .eq("auth_user_id", userData.user.id)
      .single();

    if (callerError || !callerPerson || callerPerson.access_level !== "full" || callerPerson.is_active === false) {
      return json({ error: "Forbidden: full access required" }, 403);
    }

    const body = await req.json();
    const { email, name, access_level, reports_to, daily_capacity_hours } = body ?? {};

    if (!email || !name) {
      return json({ error: "email and name are required" }, 400);
    }

    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);

    if (inviteError || !inviteData?.user) {
      return json({ error: inviteError?.message ?? "Failed to invite user" }, 400);
    }

    const { data: newPerson, error: insertError } = await adminClient
      .from("people")
      .insert({
        auth_user_id: inviteData.user.id,
        name,
        email,
        access_level: access_level === "full" ? "full" : "limited",
        reports_to: reports_to || null,
        daily_capacity_hours: daily_capacity_hours || 7.5,
      })
      .select()
      .single();

    if (insertError) {
      return json({ error: insertError.message }, 400);
    }

    return json({ person: newPerson }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
