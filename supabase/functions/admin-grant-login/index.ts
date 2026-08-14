// Sandra, 2026-08-14: discovered several real roster people (e.g. Joseph
// San Jose) have NO login at all -- auth_user_id is null. Root cause: the
// CSV bulk-import path (see admin-create-user's own comment) only calls
// admin-create-user for a row whose email doesn't match an existing
// person; a row that DOES match an existing person just updates their
// roster fields directly via the client, and never creates a Supabase
// Auth login. This function is the fix for that gap -- it attaches a
// brand-new login to an EXISTING people row (as opposed to
// admin-create-user, which always inserts a new row).
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
    const { person_id } = body ?? {};

    if (!person_id) {
      return json({ error: "person_id is required" }, 400);
    }

    const { data: targetPerson, error: targetError } = await adminClient
      .from("people")
      .select("id, email, auth_user_id")
      .eq("id", person_id)
      .single();

    if (targetError || !targetPerson) {
      return json({ error: "Person not found" }, 404);
    }

    if (targetPerson.auth_user_id) {
      return json({ error: "This person already has a login -- use Reset password instead." }, 400);
    }

    const password = generatePassword();
    const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
      email: targetPerson.email,
      password,
      email_confirm: true,
    });

    if (createError || !createData?.user) {
      return json({ error: createError?.message ?? "Failed to create login" }, 400);
    }

    const { error: updateError } = await adminClient
      .from("people")
      .update({ auth_user_id: createData.user.id })
      .eq("id", person_id);

    if (updateError) {
      // Roll back the just-created auth user so it doesn't become an
      // orphaned login with no people row pointing at it.
      await adminClient.auth.admin.deleteUser(createData.user.id);
      return json({ error: updateError.message }, 400);
    }

    return json({ password }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
