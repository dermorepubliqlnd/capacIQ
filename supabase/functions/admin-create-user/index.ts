// Sandra, 2026-08-14: CSV bulk import needs to create real logins for
// brand-new people WITHOUT sending Supabase's built-in invite email --
// she wants to hand the pilot group a link + a generated password herself
// (Slack/email/in person), not rely on an automated email landing in
// spam or going out before she's ready. Mirrors admin-invite-user's own
// auth/authorization shape exactly, just swaps
// `auth.admin.inviteUserByEmail` for `auth.admin.createUser` with a
// server-generated password and `email_confirm: true` (so the account is
// immediately usable via plain email+password sign-in, no link to click).
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

// 12 chars, unambiguous alphabet (no 0/O/1/l/I) -- easy to read aloud or
// type from a screenshot when Sandra shares it with a pilot user manually.
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
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
    const {
      email,
      name,
      access_level,
      reports_to,
      daily_capacity_hours,
      employee_id,
      job_title,
      can_approve_closures,
      can_approve_rebaseline,
      is_active,
    } = body ?? {};

    if (!email || !name) {
      return json({ error: "email and name are required" }, 400);
    }

    const password = generatePassword();

    const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError || !createData?.user) {
      return json({ error: createError?.message ?? "Failed to create user" }, 400);
    }

    const { data: newPerson, error: insertError } = await adminClient
      .from("people")
      .insert({
        auth_user_id: createData.user.id,
        name,
        email,
        access_level: access_level === "full" ? "full" : "limited",
        reports_to: reports_to || null,
        daily_capacity_hours: daily_capacity_hours || 7.5,
        employee_id: employee_id || null,
        job_title: job_title || null,
        can_approve_closures: !!can_approve_closures,
        can_approve_rebaseline: !!can_approve_rebaseline,
        is_active: is_active === false ? false : true,
      })
      .select()
      .single();

    if (insertError) {
      // Roll back the just-created auth user so a failed people-row insert
      // (e.g. a duplicate employee_id) doesn't leave an orphaned login with
      // no roster row attached to it.
      await adminClient.auth.admin.deleteUser(createData.user.id);
      return json({ error: insertError.message }, 400);
    }

    return json({ person: newPerson, password }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
