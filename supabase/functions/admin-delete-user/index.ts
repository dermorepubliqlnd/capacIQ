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
    const { person_id } = body ?? {};

    if (!person_id) {
      return json({ error: "person_id is required" }, 400);
    }

    if (person_id === callerPerson.id) {
      return json({ error: "You can't delete your own account. Ask another Full Access person to do it." }, 400);
    }

    const { data: targetPerson, error: targetError } = await adminClient
      .from("people")
      .select("id, auth_user_id, name")
      .eq("id", person_id)
      .single();

    if (targetError || !targetPerson) {
      return json({ error: "Person not found" }, 404);
    }

    // Attempt the delete. The people table is referenced (with no ON DELETE
    // CASCADE) from projects.owner_id, tasks.assignee_id, people.reports_to,
    // time_entries, project_notes, extension_requests, ownership/assignee
    // history tables, and the deleted-item archive tables. If this person
    // has ANY real history anywhere, Postgres itself throws a foreign key
    // violation (23503) and the delete is rejected -- we don't need to
    // manually enumerate every table here, just surface that error clearly.
    const { error: deleteError } = await adminClient.from("people").delete().eq("id", person_id);

    if (deleteError) {
      if (deleteError.code === "23503") {
        return json(
          {
            error:
              `"${targetPerson.name}" can't be permanently deleted -- they have history in the system ` +
              `(owns or is assigned to a project/task, has logged time, is listed as someone's manager, ` +
              `or has other records tied to their account). Use Deactivate instead to remove their access ` +
              `while keeping that history intact.`,
          },
          409,
        );
      }
      return json({ error: deleteError.message }, 400);
    }

    // people row is gone -- now remove the login itself, if one exists.
    if (targetPerson.auth_user_id) {
      const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(targetPerson.auth_user_id);
      if (authDeleteError) {
        // The people row is already gone at this point; surface this as a
        // partial-success warning rather than a hard failure.
        return json(
          {
            warning: `Person record deleted, but removing their login failed: ${authDeleteError.message}`,
          },
          200,
        );
      }
    }

    return json({ success: true }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
