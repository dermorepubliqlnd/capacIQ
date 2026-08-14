import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Send, CornerDownRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";

interface NotePersonOption {
  id: string;
  name: string;
}

interface ProjectNoteRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  mentioned_person_ids: string[];
  created_at: string;
}

interface NotesSidebarProps {
  projectId: string;
  projectName: string;
  people: NotePersonOption[];
  currentPersonId: string | null;
  onClose: () => void;
  onCountChange: (projectId: string, count: number) => void;
}

const SIDEBAR_WIDTH = 380;

function formatTimestamp(iso: string): { relative: string; full: string } {
  const d = new Date(iso);
  const full = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60000);
  let relative: string;
  if (diffMin < 1) relative = "just now";
  else if (diffMin < 60) relative = `${diffMin}m ago`;
  else if (diffMin < 60 * 24) relative = `${Math.round(diffMin / 60)}h ago`;
  else if (diffMin < 60 * 24 * 7) relative = `${Math.round(diffMin / (60 * 24))}d ago`;
  else relative = full;
  return { relative, full };
}

// Renders a note's body with any "@Full Name" substrings (matched against
// the project's own people list, not free-text parsing) highlighted as a
// mention chip -- mirrors the plain-text convention used elsewhere in the
// app (no rich-text storage, just a display-time transform).
function renderBodyWithMentions(body: string, people: NotePersonOption[]) {
  const names = people.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return body;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`@(${escaped.join("|")})`, "g");
  const parts: (string | { mention: string })[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > lastIndex) parts.push(body.slice(lastIndex, match.index));
    parts.push({ mention: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts.map((part, i) =>
    typeof part === "string" ? (
      <span key={i}>{part}</span>
    ) : (
      <span key={i} style={{ color: "var(--accent)", fontWeight: 600 }}>
        {part.mention}
      </span>
    )
  );
}

export default function NotesSidebar({ projectId, projectName, people, currentPersonId, onClose, onCountChange }: NotesSidebarProps) {
  const [notes, setNotes] = useState<ProjectNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [composeText, setComposeText] = useState("");
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [mentionMenu, setMentionMenu] = useState<{ query: string; start: number } | null>(null);
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("project_notes")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    const rows = (data as ProjectNoteRow[]) ?? [];
    setNotes(rows);
    onCountChange(projectId, rows.length);
    setLoading(false);
  }

  const topLevel = notes.filter((n) => !n.parent_id);
  const repliesFor = (id: string) => notes.filter((n) => n.parent_id === id);

  function authorName(id: string) {
    return peopleById.get(id)?.name ?? "Unknown";
  }

  function handleComposeChange(value: string) {
    setComposeText(value);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const uptoCaret = value.slice(0, caret);
    const match = uptoCaret.match(/@([a-zA-Z ]{0,24})$/);
    if (match) {
      setMentionMenu({ query: match[1].trim().toLowerCase(), start: caret - match[0].length });
    } else {
      setMentionMenu(null);
    }
  }

  function pickMention(person: NotePersonOption) {
    if (!mentionMenu) return;
    const before = composeText.slice(0, mentionMenu.start);
    const caret = textareaRef.current?.selectionStart ?? composeText.length;
    const after = composeText.slice(caret);
    const next = `${before}@${person.name} ${after}`;
    setComposeText(next);
    setMentionIds((prev) => (prev.includes(person.id) ? prev : [...prev, person.id]));
    setMentionMenu(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const pos = before.length + person.name.length + 2;
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  }

  const mentionCandidates = mentionMenu
    ? people.filter((p) => p.name.toLowerCase().includes(mentionMenu.query)).slice(0, 6)
    : [];

  async function postNote() {
    const body = composeText.trim();
    if (!body || !currentPersonId || posting) return;
    setPosting(true);
    const { error } = await supabase.from("project_notes").insert({
      project_id: projectId,
      parent_id: replyToId,
      author_id: currentPersonId,
      body,
      mentioned_person_ids: mentionIds,
    });
    setPosting(false);
    if (error) {
      window.alert(`Couldn't post note: ${error.message}`);
      return;
    }
    setComposeText("");
    setMentionIds([]);
    setReplyToId(null);
    setMentionMenu(null);
    await load();
  }

  function NoteItem({ note, isReply }: { note: ProjectNoteRow; isReply: boolean }) {
    const { relative, full } = formatTimestamp(note.created_at);
    return (
      <div style={{ marginLeft: isReply ? 22 : 0, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
          {isReply && <CornerDownRight size={12} color="var(--muted)" />}
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{authorName(note.author_id)}</span>
          <span title={full} style={{ fontSize: 11, color: "var(--muted)" }}>
            {relative}
          </span>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {renderBodyWithMentions(note.body, people)}
        </div>
        {!isReply && (
          <button
            onClick={() => {
              setReplyToId(note.id);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              marginTop: 3,
              fontSize: 11.5,
              color: "var(--accent)",
              cursor: "pointer",
            }}
          >
            Reply
          </button>
        )}
      </div>
    );
  }

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,41,66,0.25)", zIndex: 150 }} />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          background: "var(--surface)",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
          zIndex: 151,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Notes</div>
            <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{projectName}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", flexShrink: 0 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {loading && <div style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading notes…</div>}
          {!loading && topLevel.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No notes yet. Start the conversation below.</div>
          )}
          {topLevel.map((n) => (
            <div key={n.id} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: "1px solid var(--border)" }}>
              <NoteItem note={n} isReply={false} />
              {repliesFor(n.id).map((r) => (
                <NoteItem key={r.id} note={r} isReply />
              ))}
            </div>
          ))}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", padding: 12, position: "relative" }}>
          {replyToId && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>
              <span>Replying to {authorName(notes.find((n) => n.id === replyToId)?.author_id ?? "")}'s note</span>
              <button onClick={() => setReplyToId(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                <X size={12} />
              </button>
            </div>
          )}
          {mentionMenu && mentionCandidates.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: 12,
                right: 12,
                marginBottom: 4,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
                maxHeight: 160,
                overflowY: "auto",
                zIndex: 152,
              }}
            >
              {mentionCandidates.map((p) => (
                <div
                  key={p.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(p);
                  }}
                  style={{ padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}
                  className="mention-candidate-row"
                >
                  {p.name}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={composeText}
            onChange={(e) => handleComposeChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                postNote();
              }
              if (e.key === "Escape") setMentionMenu(null);
            }}
            placeholder="Add a note… type @ to tag someone"
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              fontFamily: "inherit",
              fontSize: 13,
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--border)",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
            <button
              onClick={postNote}
              disabled={!composeText.trim() || posting}
              className="btn-primary"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: !composeText.trim() || posting ? 0.6 : 1 }}
            >
              <Send size={13} /> Post
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
