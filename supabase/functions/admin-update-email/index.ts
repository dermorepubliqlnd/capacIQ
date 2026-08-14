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
    const { person_id, new_email } = body ?? {};

    if (!person_id || !new_email) {
      return json({ error: "person_id and new_email are required" }, 400);
    }

    const email = String(new_email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "That doesn't look like a valid email address" }, 400);
    }

    const { data: targetPerson, error: targetError } = await adminClient
      .from("people")
      .select("id, auth_user_id, email")
      .eq("id", person_id)
      .single();

    if (targetError || !targetPerson) {
      return json({ error: "Person not found" }, 404);
    }

    if (email === targetPerson.email) {
      return json({ error: "That's already their email" }, 400);
    }

    // Update the login's email first (this is also where Supabase will
    // reject it if another auth user already has this email).
    if (targetPerson.auth_user_id) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(targetPerson.auth_user_id, {
        email,
        email_confirm: true,
      });
      if (authUpdateError) {
        return json({ error: `Couldn't update login email: ${authUpdateError.message}` }, 400);
      }
    }

    const { data: updatedPerson, error: updateError } = await adminClient
      .from("people")
      .update({ email })
      .eq("id", person_id)
      .select()
      .single();

    if (updateError) {
      // people.email is unique -- if this fails after the auth email already
      // changed, the two are now out of sync. Surface that clearly rather
      // than silently leaving it half-done.
      return json(
        {
          error:
            `Login email was updated, but saving it to the person record failed (${updateError.message}). ` +
            `The login and the record are now out of sync -- please retry or fix manually.`,
        },
        409,
      );
    }

    return json({ person: updatedPerson }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
