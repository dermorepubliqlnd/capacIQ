import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export interface Person {
  id: string;
  name: string;
  email: string;
  access_level: "full" | "standard";
  reports_to: string | null;
  daily_capacity_hours: number;
  is_active: boolean;
  auth_user_id: string;
}

// Tracks the current Supabase Auth session and the matching `people` row
// (which carries access_level, used everywhere we need to gate a screen
// or action to Full Access users). `loading` is true until both the
// session and, if present, the person record have been resolved at least
// once — screens should show nothing (not a login redirect) while true.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadPerson(userId: string) {
      const { data } = await supabase.from("people").select("*").eq("auth_user_id", userId).single();
      if (active) setPerson((data as Person) ?? null);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session?.user) {
        loadPerson(data.session.user.id).finally(() => active && setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!active) return;
      setSession(newSession);
      if (newSession?.user) {
        loadPerson(newSession.user.id);
      } else {
        setPerson(null);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return { session, person, loading };
}
