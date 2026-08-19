import React, { useState, useEffect, useRef, useCallback } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";

const DEFAULT_TRICKS = [
  "Jump", "One Footer", "BoardOff", "BackRoll", "FrontRoll",
  "Kiteloop", "S-Loop", "Double", "x2", "Left", "Right", "Crash",
];

const ROUND_TONES = ["accent", "success", "warning", "danger", "gray"];

const emptyState = () => ({
  compName: "",
  planningDone: false,
  rounds: [],
  heats: [],
  riders: [],
  judges: [],
  spotters: [],
  tricks: [...DEFAULT_TRICKS],
  trikotColors: [],
  adminPassword: "Soulgames",
});

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---- Supabase-backed storage layer -----------------------------------
// Mirrors the shape the rest of the app already expects: an index of
// competitions, one JSON "state" blob per competition, and one JSON
// "data" blob per heat (trick log + variety scores). Swapping this out
// for real relational tables is a reasonable future step, but keeping
// the same JSON-blob shape here means the ~2000 lines of UI/business
// logic below didn't need to change at all.

async function loadIndex() {
  try {
    const { data, error } = await supabase
      .from("competitions_index")
      .select("list")
      .eq("id", "singleton")
      .maybeSingle();
    if (error) throw error;
    return { ok: true, list: data ? data.list : [] };
  } catch {
    return { ok: false, list: [] };
  }
}
async function saveIndex(list) {
  try {
    const { error } = await supabase
      .from("competitions_index")
      .upsert({ id: "singleton", list, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}
async function loadState(compId) {
  try {
    const { data, error } = await supabase
      .from("comp_state")
      .select("state")
      .eq("comp_id", compId)
      .maybeSingle();
    if (error) throw error;
    return { ok: true, state: data ? { ...emptyState(), ...data.state } : emptyState() };
  } catch {
    return { ok: false, state: emptyState() };
  }
}
async function saveState(compId, state) {
  try {
    const { error } = await supabase
      .from("comp_state")
      .upsert({ comp_id: compId, state, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}
async function loadHeat(compId, heatId) {
  try {
    const { data, error } = await supabase
      .from("heat_data")
      .select("data")
      .eq("comp_id", compId)
      .eq("heat_id", heatId)
      .maybeSingle();
    if (error) throw error;
    return { ok: true, data: data ? data.data : { log: [], variety: {} } };
  } catch {
    return { ok: false, data: { log: [], variety: {} } };
  }
}
async function saveHeat(compId, heatId, data) {
  try {
    const { error } = await supabase
      .from("heat_data")
      .upsert({ comp_id: compId, heat_id: heatId, data, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  } catch {
    return false;
  }
}

function trimmedAverage(numbers) {
  if (numbers.length === 0) return null;
  if (numbers.length >= 4) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}
function isCrash(trickName) {
  return /crash/i.test(trickName || "");
}
function trickScore(entry) {
  if (isCrash(entry.trick)) return 0;
  const nums = Object.values(entry.scores || {}).filter((s) => typeof s === "number");
  if (nums.length === 0) return null;
  return trimmedAverage(nums);
}
function varietyScoreForRider(heatData, riderId) {
  const obj = (heatData.variety || {})[riderId] || {};
  const nums = Object.values(obj).filter((s) => typeof s === "number");
  if (nums.length === 0) return null;
  return trimmedAverage(nums);
}
function riderTotal(heatData, riderId) {
  const entries = (heatData.log || []).filter((e) => e.riderId === riderId);
  const scores = entries.map(trickScore).filter((s) => s !== null).sort((a, b) => b - a);
  const top3 = scores.slice(0, 3);
  const sumTop3 = top3.reduce((a, b) => a + b, 0);
  const variety = varietyScoreForRider(heatData, riderId);
  const hasAnyScore = scores.length > 0 || variety !== null;
  return { sumTop3, variety, total: sumTop3 + (variety || 0), trickCount: entries.length, hasAnyScore };
}
function riderTrickBreakdown(heatData, riderId) {
  const entries = (heatData.log || []).filter((e) => e.riderId === riderId && e.trick && !isCrash(e.trick));
  const left = [];
  const right = [];
  const neutral = [];
  entries.forEach((e) => {
    const lower = e.trick.toLowerCase();
    if (lower.includes("left")) left.push(e.trick);
    else if (lower.includes("right")) right.push(e.trick);
    else neutral.push(e.trick);
  });
  return { left, right, neutral };
}
function round1(n) {
  return Math.round(n * 10) / 10;
}

function orderedHeats(state) {
  const result = [];
  state.rounds.forEach((round) => {
    state.heats.filter((h) => h.roundId === round.id).forEach((h) => result.push(h));
  });
  return result;
}
function heatNumber(state, heatId) {
  const idx = orderedHeats(state).findIndex((h) => h.id === heatId);
  return idx === -1 ? "?" : idx + 1;
}
function resolveSlotRider(state, slot) {
  if (slot.override) return slot.override;
  if (slot.source.type === "rank") {
    const r = state.riders.find((r) => Number(r.rank) === Number(slot.source.rank));
    return r ? r.id : null;
  }
  if (slot.source.type === "result") {
    const srcHeat = state.heats.find((h) => h.id === slot.source.heatId);
    if (srcHeat && srcHeat.finalRanking) return srcHeat.finalRanking[slot.source.place - 1] || null;
  }
  return null;
}
function heatRiderIds(state, heat) {
  return heat.slots.map((s) => resolveSlotRider(state, s)).filter(Boolean);
}
function riderColorHex(state, heat, riderId) {
  if (!heat || !state.trikotColors || state.trikotColors.length === 0) return null;
  const idx = heat.slots.findIndex((sl) => resolveSlotRider(state, sl) === riderId);
  if (idx === -1) return null;
  const slot = heat.slots[idx];
  if (slot.colorOverride) {
    const c = state.trikotColors.find((c) => c.id === slot.colorOverride);
    if (c) return c.hex;
  }
  return state.trikotColors[idx % state.trikotColors.length].hex;
}
function riderName(state, id) {
  return state.riders.find((r) => r.id === id)?.name || null;
}
function slotLabel(state, slot) {
  if (slot.source.type === "rank") return `Rank ${slot.source.rank}`;
  const h = state.heats.find((x) => x.id === slot.source.heatId);
  return `Heat ${h ? heatNumber(state, h.id) : "?"} · place ${slot.source.place}`;
}

const WRITE_GRACE_MS = 1500;

function reportStorageStatus(ok) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("kite-comp-storage-status", { detail: { ok } }));
  }
}

// Realtime-first sync: Supabase pushes changes the instant another device
// writes, instead of waiting for the next poll tick. A slow poll (10s)
// stays on as a safety net in case a realtime event is ever missed
// (e.g. a brief disconnect), the same way the original design had one.
function useSharedState(compId, pollMs = 10000) {
  const [state, setState] = useState(emptyState());
  const [ready, setReady] = useState(false);
  const lastWriteRef = useRef(0);
  const pendingRef = useRef(null);
  const writingRef = useRef(false);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const applyIncoming = useCallback((s) => {
    const localRev = stateRef.current._rev || 0;
    const fetchedRev = s._rev || 0;
    if (stateRef.current && fetchedRev < localRev) return;
    setState(s);
    setReady(true);
  }, []);

  const flush = useCallback(async () => {
    if (writingRef.current || pendingRef.current === null) return;
    writingRef.current = true;
    const toWrite = pendingRef.current;
    pendingRef.current = null;
    const ok = await saveState(compId, toWrite);
    reportStorageStatus(ok);
    writingRef.current = false;
    if (pendingRef.current !== null) flush();
  }, [compId]);

  useEffect(() => {
    if (!compId) return;
    let stop = false;
    setReady(false);

    async function refresh() {
      if (Date.now() - lastWriteRef.current < WRITE_GRACE_MS) return;
      const { ok, state: s } = await loadState(compId);
      reportStorageStatus(ok);
      if (stop) return;
      applyIncoming(s);
    }
    refresh();

    const channel = supabase
      .channel(`comp_state:${compId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "comp_state", filter: `comp_id=eq.${compId}` },
        (payload) => {
          if (Date.now() - lastWriteRef.current < WRITE_GRACE_MS) return;
          const row = payload.new;
          if (row && row.state) applyIncoming({ ...emptyState(), ...row.state });
        }
      )
      .subscribe();

    const iv = setInterval(refresh, pollMs);
    return () => {
      stop = true;
      clearInterval(iv);
      supabase.removeChannel(channel);
    };
  }, [compId, pollMs, applyIncoming]);

  const update = useCallback(
    (fn) => {
      if (!compId) return;
      lastWriteRef.current = Date.now();
      setState((prev) => {
        const next = fn(prev);
        next._rev = (prev._rev || 0) + 1;
        pendingRef.current = next;
        flush();
        return next;
      });
    },
    [compId, flush]
  );

  return [state, update, ready];
}

function useHeatData(compId, heatId, pollMs = 8000) {
  const [data, setData] = useState({ log: [], variety: {} });
  const lastWriteRef = useRef(0);
  const pendingRef = useRef(null);
  const writingRef = useRef(false);
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const applyIncoming = useCallback((d) => {
    const localRev = dataRef.current._rev || 0;
    const fetchedRev = d._rev || 0;
    if (fetchedRev < localRev) return;
    setData(d);
  }, []);

  const flush = useCallback(async () => {
    if (writingRef.current || pendingRef.current === null) return;
    writingRef.current = true;
    const toWrite = pendingRef.current;
    pendingRef.current = null;
    const ok = await saveHeat(compId, heatId, toWrite);
    reportStorageStatus(ok);
    writingRef.current = false;
    if (pendingRef.current !== null) flush();
  }, [compId, heatId]);

  useEffect(() => {
    if (!heatId || !compId) return;
    let stop = false;

    async function refresh() {
      if (Date.now() - lastWriteRef.current < WRITE_GRACE_MS) return;
      const { ok, data: d } = await loadHeat(compId, heatId);
      reportStorageStatus(ok);
      if (stop) return;
      applyIncoming(d);
    }
    refresh();

    const channel = supabase
      .channel(`heat_data:${compId}:${heatId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "heat_data", filter: `comp_id=eq.${compId}` },
        (payload) => {
          const row = payload.new;
          if (!row || row.heat_id !== heatId) return;
          if (Date.now() - lastWriteRef.current < WRITE_GRACE_MS) return;
          applyIncoming(row.data);
        }
      )
      .subscribe();

    const iv = setInterval(refresh, pollMs);
    return () => {
      stop = true;
      clearInterval(iv);
      supabase.removeChannel(channel);
    };
  }, [compId, heatId, pollMs, applyIncoming]);

  const update = useCallback(
    (fn) => {
      if (!heatId || !compId) return;
      lastWriteRef.current = Date.now();
      setData((prev) => {
        const next = fn(prev);
        next._rev = (prev._rev || 0) + 1;
        pendingRef.current = next;
        flush();
        return next;
      });
    },
    [compId, heatId, flush]
  );

  return [data, update];
}

const btn = (active) => ({
  padding: "10px 16px",
  borderRadius: "var(--radius, 8px)",
  border: `1px solid ${active ? "var(--border-accent, #378ADD)" : "var(--border-strong, #C7C5BC)"}`,
  background: active ? "var(--bg-accent-muted, #EAF1FB)" : "var(--surface-1, #F1EFE8)",
  color: active ? "var(--text-accent, #185FA5)" : "var(--text-primary, #2C2C2A)",
  fontWeight: 500,
  fontSize: 14,
});

function Card({ children, style }) {
  return (
    <div
      style={{
        background: "var(--surface-2, #FFFFFF)",
        border: "0.5px solid var(--border, #D9D7CE)",
        borderRadius: 12,
        padding: "1.1rem 1.25rem",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
function SectionLabel({ children }) {
  return (
    <p style={{ fontSize: 12, fontWeight: 500, letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--text-muted, #888780)", margin: "0 0 8px 0" }}>
      {children}
    </p>
  );
}
function Pill({ children, tone = "gray" }) {
  const tones = {
    gray: { bg: "var(--surface-1, #F1EFE8)", text: "var(--text-secondary, #5F5E5A)" },
    accent: { bg: "var(--bg-accent, #E6F1FB)", text: "var(--text-accent, #185FA5)" },
    danger: { bg: "var(--bg-danger, #FCEBEB)", text: "var(--text-danger, #A32D2D)" },
    success: { bg: "var(--bg-success, #EAF3DE)", text: "var(--text-success, #3B6D11)" },
    warning: { bg: "var(--bg-warning, #FAEEDA)", text: "var(--text-warning, #854F0B)" },
  };
  const t = tones[tone] || tones.gray;
  return (
    <span style={{ background: t.bg, color: t.text, fontSize: 12, padding: "3px 10px", borderRadius: 999, fontWeight: 500 }}>
      {children}
    </span>
  );
}
function IconBtn({ icon, onClick, label, style }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} style={{ ...btn(false), padding: "8px 10px", ...style }}>
      {icon}
    </button>
  );
}
function Header({ title, onBack }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.25rem" }}>
      {onBack && <IconBtn icon="←" onClick={onBack} label="Back" />}
      <h2 style={{ margin: 0 }}>{title}</h2>
    </div>
  );
}

function RoleSelect({ onPick, compName }) {
  const roles = [
    { id: "admin", label: "Admin", desc: "Plan the competition and run it live" },
    { id: "spotter", label: "Spotter", desc: "Log tricks as riders land them" },
    { id: "judge", label: "Judge", desc: "Score tricks and variety" },
    { id: "leaderboard", label: "Leaderboard", desc: "Live rankings" },
    { id: "bracket", label: "Bracket", desc: "Full competition structure" },
  ];
  return (
    <div>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>{compName || "Kite competition judging"}</h2>
      <p style={{ color: "var(--text-secondary, #5F5E5A)", marginTop: 0, marginBottom: "1.25rem", fontSize: 14 }}>Pick your role for this session.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {roles.map((r) => (
          <button
            key={r.id}
            onClick={() => onPick(r.id)}
            style={{ ...btn(false), textAlign: "left", height: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "1rem" }}
          >
            <span style={{ fontWeight: 500, fontSize: 15 }}>{r.label}</span>
            <span style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", fontWeight: 400 }}>{r.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function validateRoster(riders) {
  const errors = [];
  const rankCounts = {};
  riders.forEach((r) => {
    if (r.rank === "" || r.rank === undefined || r.rank === null || isNaN(Number(r.rank))) {
      errors.push(`"${r.name}" has no rank`);
    } else {
      rankCounts[Number(r.rank)] = (rankCounts[Number(r.rank)] || 0) + 1;
    }
  });
  Object.entries(rankCounts).forEach(([rank, count]) => {
    if (count > 1) errors.push(`Rank ${rank} is used ${count} times`);
  });
  const ranks = Object.keys(rankCounts).map(Number);
  const max = ranks.length ? Math.max(...ranks) : 0;
  for (let i = 1; i <= max; i++) {
    if (!rankCounts[i]) errors.push(`Rank ${i} was never assigned`);
  }
  return errors;
}

function onEnter(fn) {
  return (e) => {
    if (e.key === "Enter") fn();
  };
}

function PlanningTab({ state, update }) {
  const [nameDraft, setNameDraft] = useState(state.compName);
  const [roundName, setRoundName] = useState("");
  const [heatCount, setHeatCount] = useState(4);
  const [maxAttempts, setMaxAttempts] = useState(8);
  const [slotDrafts, setSlotDrafts] = useState({});

  const setCompName = () => {
    if (!nameDraft.trim()) return;
    update((s) => ({ ...s, compName: nameDraft.trim() }));
  };

  const addRound = () => {
    if (!roundName.trim() || heatCount < 1) return;
    const roundId = uid();
    update((s) => {
      const newHeats = Array.from({ length: heatCount }).map(() => ({
        id: uid(),
        roundId,
        status: "pending",
        slots: [],
        finalRanking: null,
      }));
      return {
        ...s,
        rounds: [...s.rounds, { id: roundId, name: roundName.trim(), toneIndex: s.rounds.length % ROUND_TONES.length, maxAttempts: Math.max(1, Number(maxAttempts) || 8) }],
        heats: [...s.heats, ...newHeats],
      };
    });
    setRoundName("");
    setHeatCount(4);
  };

  const startEditSlot = (heatId, slot) => {
    setSlotDrafts((d) => ({
      ...d,
      [heatId]: {
        editingId: slot.id,
        rank: slot.source.type === "rank" ? slot.source.rank : "",
        fromHeatNumber: slot.source.type === "result" ? heatNumber(state, slot.source.heatId) : "",
        place: slot.source.type === "result" ? slot.source.place : "",
      },
    }));
  };
  const cancelEdit = (heatId) => setSlotDrafts((d) => ({ ...d, [heatId]: {} }));

  const addSlot = (heatId, isFirstRound, prevHeats) => {
    const draft = slotDrafts[heatId] || {};
    let source;
    let rankEl, placeEl, fromHeatEl;
    if (isFirstRound) {
      rankEl = document.getElementById(`rank-input-${heatId}`);
      const rankVal = rankEl ? rankEl.value : "";
      if (!rankVal) return;
      source = { type: "rank", rank: Number(rankVal) };
    } else {
      fromHeatEl = document.getElementById(`fromheat-input-${heatId}`);
      placeEl = document.getElementById(`place-input-${heatId}`);
      const fromHeatVal = fromHeatEl ? fromHeatEl.value : "";
      const placeVal = placeEl ? placeEl.value : "";
      if (!fromHeatVal || !placeVal) return;
      const targetHeat = prevHeats.find((ph) => heatNumber(state, ph.id) === Number(fromHeatVal));
      if (!targetHeat) return;
      source = { type: "result", heatId: targetHeat.id, place: Number(placeVal) };
    }
    update((s) => ({
      ...s,
      heats: s.heats.map((h) => {
        if (h.id !== heatId) return h;
        if (draft.editingId) {
          return { ...h, slots: h.slots.map((sl) => (sl.id === draft.editingId ? { ...sl, source } : sl)) };
        }
        return { ...h, slots: [...h.slots, { id: uid(), source, override: null }] };
      }),
    }));
    setSlotDrafts((d) => ({ ...d, [heatId]: {} }));
    if (rankEl) rankEl.value = "";
    if (placeEl) placeEl.value = "";
    if (fromHeatEl) fromHeatEl.value = "";
    setTimeout(() => {
      if (isFirstRound && rankEl) rankEl.focus();
      if (!isFirstRound && fromHeatEl) fromHeatEl.focus();
    }, 0);
  };
  const removeSlot = (heatId, slotId) =>
    update((s) => ({ ...s, heats: s.heats.map((h) => (h.id === heatId ? { ...h, slots: h.slots.filter((sl) => sl.id !== slotId) } : h)) }));

  const [editingRoundId, setEditingRoundId] = useState(null);
  const [roundDraft, setRoundDraft] = useState({ name: "", count: 1, maxAttempts: 8 });
  const startEditRound = (round, heatCountNow) => {
    setEditingRoundId(round.id);
    setRoundDraft({ name: round.name, count: heatCountNow, maxAttempts: round.maxAttempts || 8 });
  };
  const cancelEditRound = () => setEditingRoundId(null);
  const saveRoundEdit = (round, currentHeats) => {
    const newCount = Math.max(1, Number(roundDraft.count) || 1);
    const newMaxAttempts = Math.max(1, Number(roundDraft.maxAttempts) || 8);
    update((s) => {
      let heats = s.heats;
      const roundHeats = heats.filter((h) => h.roundId === round.id);
      if (newCount > roundHeats.length) {
        const toAdd = newCount - roundHeats.length;
        const extras = Array.from({ length: toAdd }).map(() => ({
          id: uid(),
          roundId: round.id,
          status: "pending",
          slots: [],
          finalRanking: null,
        }));
        heats = [...heats, ...extras];
      } else if (newCount < roundHeats.length) {
        const toRemoveIds = roundHeats.slice(newCount).map((h) => h.id);
        heats = heats.filter((h) => !toRemoveIds.includes(h.id));
      }
      return {
        ...s,
        rounds: s.rounds.map((r) => (r.id === round.id ? { ...r, name: roundDraft.name.trim() || r.name, maxAttempts: newMaxAttempts } : r)),
        heats,
      };
    });
    setEditingRoundId(null);
  };
  const deleteRound = (round) => {
    update((s) => ({
      ...s,
      rounds: s.rounds.filter((r) => r.id !== round.id),
      heats: s.heats.filter((h) => h.roundId !== round.id),
    }));
    setEditingRoundId(null);
  };

  const finishPlanning = () => update((s) => ({ ...s, planningDone: true }));

  const earlierHeats = (heatRoundId) => {
    const roundIdx = state.rounds.findIndex((r) => r.id === heatRoundId);
    const earlierRoundIds = state.rounds.slice(0, roundIdx).map((r) => r.id);
    return state.heats.filter((h) => earlierRoundIds.includes(h.roundId));
  };

  return (
    <div>
      {!state.compName && (
        <Card style={{ marginBottom: 16 }}>
          <SectionLabel>Competition name</SectionLabel>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="e.g. KOL 26 — Men's Division"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={onEnter(setCompName)}
              style={{ flex: 1 }}
            />
            <button style={btn(false)} onClick={setCompName}>Set name</button>
          </div>
        </Card>
      )}

      {state.compName && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
            {state.rounds.map((round, ridx) => {
              const heats = state.heats.filter((h) => h.roundId === round.id);
              const isFirstRound = ridx === 0;
              return (
                <Card key={round.id}>
                  {editingRoundId === round.id ? (
                    <div style={{ marginBottom: 12, padding: "10px 12px", border: "0.5px solid var(--border-accent, #378ADD)", borderRadius: 8, background: "var(--bg-accent, #E6F1FB)" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <div style={{ flex: 2, minWidth: 140 }}>
                          <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Round name</label>
                          <input
                            value={roundDraft.name}
                            onChange={(e) => setRoundDraft((d) => ({ ...d, name: e.target.value }))}
                            onKeyDown={onEnter(() => saveRoundEdit(round, heats))}
                            style={{ width: "100%" }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Number of heats</label>
                          <input
                            type="number"
                            min="1"
                            value={roundDraft.count}
                            onChange={(e) => setRoundDraft((d) => ({ ...d, count: e.target.value }))}
                            onKeyDown={onEnter(() => saveRoundEdit(round, heats))}
                            style={{ width: 90 }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Trick attempts</label>
                          <input
                            type="number"
                            min="1"
                            value={roundDraft.maxAttempts}
                            onChange={(e) => setRoundDraft((d) => ({ ...d, maxAttempts: e.target.value }))}
                            onKeyDown={onEnter(() => saveRoundEdit(round, heats))}
                            style={{ width: 90 }}
                          />
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button style={btn(true)} onClick={() => saveRoundEdit(round, heats)}>Save</button>
                        <button style={btn(false)} onClick={cancelEditRound}>Cancel</button>
                        <button
                          style={{ ...btn(false), marginLeft: "auto", color: "var(--text-danger, #A32D2D)", borderColor: "var(--border-danger, #E24B4A)" }}
                          onClick={() => deleteRound(round)}
                        >
                          Delete round
                        </button>
                      </div>
                      {roundDraft.count < heats.length && (
                        <p style={{ fontSize: 12, color: "var(--text-danger, #A32D2D)", marginTop: 8, marginBottom: 0 }}>
                          Shrinking will delete the last {heats.length - roundDraft.count} heat(s) in this round, including any slots or scores in them.
                        </p>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <button
                        onClick={() => startEditRound(round, heats.length)}
                        style={{ ...btn(false), padding: "3px 10px", borderRadius: 999, fontSize: 13, color: "var(--text-accent, #185FA5)", borderColor: "var(--border-accent, #378ADD)", background: "var(--bg-accent, #E6F1FB)" }}
                      >
                        {round.name}
                      </button>
                      <span style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>{heats.length} heats</span>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {heats.map((h) => {
                      const draft = slotDrafts[h.id] || {};
                      const prevHeats = earlierHeats(round.id);
                      return (
                        <div key={h.id} style={{ border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8, padding: "10px 12px" }}>
                          <p style={{ margin: "0 0 6px 0", fontWeight: 500, fontSize: 13 }}>Heat {heatNumber(state, h.id)}</p>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                            {h.slots.map((sl) => (
                              <span
                                key={sl.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 2,
                                  fontSize: 12,
                                  background: draft.editingId === sl.id ? "var(--bg-accent-muted, #EAF1FB)" : "var(--surface-1, #F1EFE8)",
                                  border: "0.5px solid var(--border, #D9D7CE)",
                                  borderRadius: 999,
                                  padding: "2px 6px 2px 2px",
                                }}
                              >
                                <button
                                  onClick={() => startEditSlot(h.id, sl)}
                                  aria-label={`Edit ${slotLabel(state, sl)}`}
                                  style={{ border: "none", padding: "4px 8px", background: "none", fontSize: 12, color: "var(--text-accent, #185FA5)", cursor: "pointer" }}
                                >
                                  {slotLabel(state, sl)}
                                </button>
                                <button onClick={() => removeSlot(h.id, sl.id)} aria-label="Delete slot" style={{ border: "none", padding: "2px 4px", background: "none", fontSize: 14, color: "var(--text-danger, #A32D2D)", cursor: "pointer" }}>
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                          {isFirstRound ? (
                            <div>
                              <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>{draft.editingId ? "Edit rank" : "Rank"}</label>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  key={`rank-${h.id}-${draft.editingId || "new"}`}
                                  id={`rank-input-${h.id}`}
                                  type="number"
                                  placeholder="e.g. 3"
                                  style={{ width: 90 }}
                                  defaultValue={draft.rank || ""}
                                  onKeyDown={onEnter(() => addSlot(h.id, true, prevHeats))}
                                />
                                <button style={btn(false)} onClick={() => addSlot(h.id, true, prevHeats)}>{draft.editingId ? "Save change" : "Add slot"}</button>
                                {draft.editingId && <button style={btn(false)} onClick={() => cancelEdit(h.id)}>Cancel</button>}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>{draft.editingId ? "Edit source" : "From heat, place"}</label>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <input
                                  key={`fromheat-${h.id}-${draft.editingId || "new"}`}
                                  id={`fromheat-input-${h.id}`}
                                  type="number"
                                  placeholder="From heat"
                                  style={{ width: 100 }}
                                  defaultValue={draft.fromHeatNumber || ""}
                                  onKeyDown={onEnter(() => addSlot(h.id, false, prevHeats))}
                                />
                                <input
                                  key={`place-${h.id}-${draft.editingId || "new"}`}
                                  id={`place-input-${h.id}`}
                                  type="number"
                                  placeholder="Place"
                                  style={{ width: 80 }}
                                  defaultValue={draft.place || ""}
                                  onKeyDown={onEnter(() => addSlot(h.id, false, prevHeats))}
                                />
                                <button style={btn(false)} onClick={() => addSlot(h.id, false, prevHeats)}>{draft.editingId ? "Save change" : "Add slot"}</button>
                                {draft.editingId && <button style={btn(false)} onClick={() => cancelEdit(h.id)}>Cancel</button>}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>

          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Add a round</SectionLabel>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 2, minWidth: 160 }}>
                <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Round name</label>
                <input
                  placeholder="e.g. Quarter Final"
                  value={roundName}
                  onChange={(e) => setRoundName(e.target.value)}
                  onKeyDown={onEnter(addRound)}
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Number of heats</label>
                <input
                  type="number"
                  min="1"
                  value={heatCount}
                  onChange={(e) => setHeatCount(Number(e.target.value))}
                  onKeyDown={onEnter(addRound)}
                  style={{ width: 90 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--text-muted, #888780)", display: "block", marginBottom: 4 }}>Trick attempts</label>
                <input
                  type="number"
                  min="1"
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(Number(e.target.value))}
                  onKeyDown={onEnter(addRound)}
                  style={{ width: 90 }}
                />
              </div>
              <button style={btn(false)} onClick={addRound}>
                Create round
              </button>
            </div>
          </Card>

          {!state.planningDone && state.rounds.length > 0 && (
            <button style={btn(true)} onClick={finishPlanning}>
              Done — finish planning
            </button>
          )}
          {state.planningDone && <Pill tone="success">Planning complete</Pill>}
        </>
      )}
    </div>
  );
}

function VarietyStatus({ state, heat, compId }) {
  const [data] = useHeatData(compId, heat.id);
  const riderIds = heatRiderIds(state, heat);
  const approvedJudges = state.judges.filter((j) => j.status === "approved");
  if (approvedJudges.length === 0) {
    return <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", margin: "6px 0 0 0" }}>No approved judges yet.</p>;
  }
  const submittedJudgeIds = approvedJudges.filter((j) => riderIds.every((rid) => (data.variety || {})[rid]?.[j.id] !== undefined));
  const missing = approvedJudges.filter((j) => !submittedJudgeIds.includes(j));
  return (
    <p style={{ fontSize: 12, color: missing.length ? "var(--text-danger, #A32D2D)" : "var(--text-success, #3B6D11)", margin: "6px 0 0 0" }}>
      Variety: {submittedJudgeIds.length} of {approvedJudges.length} judges submitted
      {missing.length > 0 ? ` — waiting on ${missing.map((j) => j.name).join(", ")}` : " — all in"}
    </p>
  );
}

function HeatEntriesPanel({ state, heat, compId }) {
  const [data, updateHeat] = useHeatData(compId, heat.id, 6000);
  const [editingCell, setEditingCell] = useState(null);
  const riderIds = heatRiderIds(state, heat);
  const approvedJudges = state.judges.filter((j) => j.status === "approved");

  const setTrickScore = (entryId, judgeId, value) =>
    updateHeat((d) => ({ ...d, log: (d.log || []).map((e) => (e.id === entryId ? { ...e, scores: { ...e.scores, [judgeId]: value } } : e)) }));
  const clearTrickScore = (entryId, judgeId) =>
    updateHeat((d) => ({
      ...d,
      log: (d.log || []).map((e) => {
        if (e.id !== entryId) return e;
        const scores = { ...e.scores };
        delete scores[judgeId];
        return { ...e, scores };
      }),
    }));
  const deleteEntry = (entryId) => updateHeat((d) => ({ ...d, log: (d.log || []).filter((e) => e.id !== entryId) }));
  const editTrickName = (entryId, name) => updateHeat((d) => ({ ...d, log: (d.log || []).map((e) => (e.id === entryId ? { ...e, trick: name } : e)) }));
  const setVariety = (riderId, judgeId, value) =>
    updateHeat((d) => {
      const variety = { ...(d.variety || {}) };
      variety[riderId] = { ...(variety[riderId] || {}), [judgeId]: value };
      return { ...d, variety };
    });
  const clearVariety = (riderId, judgeId) =>
    updateHeat((d) => {
      const variety = { ...(d.variety || {}) };
      if (variety[riderId]) {
        const v = { ...variety[riderId] };
        delete v[judgeId];
        variety[riderId] = v;
      }
      return { ...d, variety };
    });

  const chipStyle = { fontSize: 11, padding: "3px 8px", borderRadius: 999, border: "0.5px solid var(--border, #D9D7CE)", background: "var(--surface-1, #F1EFE8)", cursor: "pointer" };

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--border, #D9D7CE)" }}>
      <SectionLabel>Trick log — admin override</SectionLabel>
      {(data.log || []).length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>No tricks logged yet.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {(data.log || []).slice().reverse().map((e) => (
          <div key={e.id} style={{ border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8, padding: "8px 10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{riderName(state, e.riderId) || "Unknown"}</span>
              <button onClick={() => deleteEntry(e.id)} style={{ border: "none", background: "none", color: "var(--text-danger, #A32D2D)", fontSize: 12, cursor: "pointer" }}>
                Delete entry
              </button>
            </div>
            <input
              key={`trick-name-${e.id}`}
              id={`trick-name-${e.id}`}
              defaultValue={e.trick}
              onKeyDown={onEnter(() => {
                const el = document.getElementById(`trick-name-${e.id}`);
                if (el) editTrickName(e.id, el.value);
              })}
              style={{ fontSize: 13, width: "100%", marginBottom: 6 }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {approvedJudges.map((j) => {
                const val = e.scores[j.id];
                const cellKey = `${e.id}:${j.id}`;
                if (editingCell === cellKey) {
                  return (
                    <span key={j.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        id={`edit-${cellKey}`}
                        type="number"
                        step="0.5"
                        defaultValue={typeof val === "number" ? val : ""}
                        style={{ width: 60, fontSize: 12 }}
                        onKeyDown={onEnter(() => {
                          const el = document.getElementById(`edit-${cellKey}`);
                          if (el && el.value !== "") {
                            setTrickScore(e.id, j.id, Number(el.value));
                            setEditingCell(null);
                          }
                        })}
                      />
                      <button
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          const el = document.getElementById(`edit-${cellKey}`);
                          if (el && el.value !== "") {
                            setTrickScore(e.id, j.id, Number(el.value));
                            setEditingCell(null);
                          }
                        }}
                      >
                        Save
                      </button>
                      <button
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          clearTrickScore(e.id, j.id);
                          setEditingCell(null);
                        }}
                      >
                        Clear
                      </button>
                    </span>
                  );
                }
                return (
                  <button key={j.id} onClick={() => setEditingCell(cellKey)} style={chipStyle}>
                    {j.name}: {val === "skip" ? "skip" : typeof val === "number" ? val : "—"}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <SectionLabel>Variety scores — admin override</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {riderIds.map((rid) => (
          <div key={rid} style={{ fontSize: 13 }}>
            <span style={{ fontWeight: 500, marginRight: 8 }}>{riderName(state, rid)}</span>
            {approvedJudges.map((j) => {
              const val = (data.variety || {})[rid]?.[j.id];
              const cellKey = `variety:${rid}:${j.id}`;
              if (editingCell === cellKey) {
                return (
                  <span key={j.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 8 }}>
                    <input
                      id={`edit-${cellKey}`}
                      type="number"
                      step="0.5"
                      defaultValue={typeof val === "number" ? val : ""}
                      style={{ width: 60, fontSize: 12 }}
                      onKeyDown={onEnter(() => {
                        const el = document.getElementById(`edit-${cellKey}`);
                        if (el && el.value !== "") {
                          setVariety(rid, j.id, Number(el.value));
                          setEditingCell(null);
                        }
                      })}
                    />
                    <button
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        const el = document.getElementById(`edit-${cellKey}`);
                        if (el && el.value !== "") {
                          setVariety(rid, j.id, Number(el.value));
                          setEditingCell(null);
                        }
                      }}
                    >
                      Save
                    </button>
                    <button
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        clearVariety(rid, j.id);
                        setEditingCell(null);
                      }}
                    >
                      Clear
                    </button>
                  </span>
                );
              }
              return (
                <button key={j.id} onClick={() => setEditingCell(cellKey)} style={{ ...chipStyle, marginRight: 6 }}>
                  {j.name}: {typeof val === "number" ? val : "—"}
                </button>
              );
            })}
          </div>
        ))}
        {riderIds.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>No riders resolved yet.</p>}
      </div>
    </div>
  );
}

function AdminGate({ state, update, onBack, compId }) {
  const adminKey = `kite-comp:admin-pw:${compId}`;
  const [unlocked, setUnlocked] = useState(() => {
    try {
      const saved = localStorage.getItem(adminKey);
      const expected = state.adminPassword || "Soulgames";
      return !!saved && saved === expected;
    } catch {
      return false;
    }
  });
  const [pwInput, setPwInput] = useState("");
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(true);

  const tryUnlock = () => {
    const expected = state.adminPassword || "Soulgames";
    if (pwInput === expected) {
      setUnlocked(true);
      setError("");
      if (remember) {
        try {
          localStorage.setItem(adminKey, pwInput);
        } catch {}
      }
    } else {
      setError("Wrong password.");
    }
  };

  const forgetDevice = () => {
    try {
      localStorage.removeItem(adminKey);
    } catch {}
    setUnlocked(false);
    setPwInput("");
  };

  if (!unlocked) {
    return (
      <div>
        <Header title="Admin" onBack={onBack} />
        <Card>
          <SectionLabel>Password required</SectionLabel>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <PasswordField value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={onEnter(tryUnlock)} placeholder="Admin password" />
            <button style={btn(true)} onClick={tryUnlock}>Unlock</button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary, #5F5E5A)" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device
          </label>
          {error && <p style={{ color: "var(--text-danger, #A32D2D)", fontSize: 13, marginTop: 8, marginBottom: 0 }}>{error}</p>}
        </Card>
      </div>
    );
  }

  return <AdminView state={state} update={update} onBack={onBack} compId={compId} onForgetDevice={forgetDevice} />;
}

function ShareLinkCard({ compId }) {
  const [copied, setCopied] = useState(false);
  let link = "";
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("comp", compId);
    link = url.toString();
  } catch {}

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <Card style={{ marginBottom: 16 }}>
      <SectionLabel>Share this competition</SectionLabel>
      <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
        Send judges, spotters, and spectators this link — it opens straight into this competition without needing
        the admin password.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <input readOnly value={link} onClick={(e) => e.target.select()} style={{ flex: 1, fontSize: 12 }} />
        <button style={btn(copied)} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </Card>
  );
}

function AdminView({ state, update, onBack, compId, onForgetDevice }) {
  const [tab, setTab] = useState(state.planningDone ? "riders" : "plan");
  const [newRider, setNewRider] = useState("");
  const [newRank, setNewRank] = useState("");
  const [newTrick, setNewTrick] = useState("");
  const [uploadPreview, setUploadPreview] = useState(null);
  const [uploadError, setUploadError] = useState("");

  const addRider = () => {
    if (!newRider.trim() || newRank === "") return;
    update((s) => ({ ...s, riders: [...s.riders, { id: uid(), name: newRider.trim(), rank: Number(newRank) }] }));
    setNewRider("");
    setNewRank("");
  };
  const removeRider = (id) => update((s) => ({ ...s, riders: s.riders.filter((r) => r.id !== id) }));

  const handleRosterFile = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(new Uint8Array(evt.target.result), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        if (rows.length === 0) {
          setUploadError("That sheet looks empty.");
          return;
        }
        const keys = Object.keys(rows[0]);
        const nameKey = keys.find((k) => /name/i.test(k)) || keys[0];
        const rankKey = keys.find((k) => /rank|seed|rating/i.test(k)) || keys[1];
        const parsed = rows
          .map((r) => ({ id: uid(), name: String(r[nameKey] || "").trim(), rank: r[rankKey] }))
          .filter((r) => r.name);
        setUploadPreview(parsed);
      } catch {
        setUploadError("Couldn't read that file. Make sure it's a .xlsx or .csv with a name column and a rank column.");
      }
    };
    reader.readAsArrayBuffer(file);
  };
  const confirmUpload = () => {
    update((s) => ({ ...s, riders: uploadPreview }));
    setUploadPreview(null);
  };
  const rosterWarnings = validateRoster(state.riders);
  const uploadWarnings = uploadPreview ? validateRoster(uploadPreview) : [];

  const setHeatStatus = (id, status) => update((s) => ({ ...s, heats: s.heats.map((h) => (h.id === id ? { ...h, status } : h)) }));
  const finalizeHeat = async (heat) => {
    const data = await loadHeat(heat.id);
    const rids = heatRiderIds(state, heat);
    const ranking = rids
      .map((rid) => ({ rid, ...riderTotal(data, rid) }))
      .sort((a, b) => b.total - a.total)
      .map((r) => r.rid);
    update((s) => ({ ...s, heats: s.heats.map((h) => (h.id === heat.id ? { ...h, status: "complete", finalRanking: ranking } : h)) }));
  };
  const setOverride = (heatId, slotId, riderId) =>
    update((s) => ({
      ...s,
      heats: s.heats.map((h) =>
        h.id === heatId ? { ...h, slots: h.slots.map((sl) => (sl.id === slotId ? { ...sl, override: riderId || null } : sl)) } : h
      ),
    }));
  const setSlotColor = (heatId, slotId, colorId) =>
    update((s) => ({
      ...s,
      heats: s.heats.map((h) =>
        h.id === heatId ? { ...h, slots: h.slots.map((sl) => (sl.id === slotId ? { ...sl, colorOverride: colorId || null } : sl)) } : h
      ),
    }));

  const removeJudge = (id) => update((s) => ({ ...s, judges: s.judges.filter((j) => j.id !== id) }));
  const generateJudgePin = (id) => update((s) => ({ ...s, judges: s.judges.map((j) => (j.id === id ? { ...j, pendingPin: genPin() } : j)) }));
  const clearJudgePin = (id) => update((s) => ({ ...s, judges: s.judges.map((j) => (j.id === id ? { ...j, pendingPin: null } : j)) }));
  const removeSpotter = (id) => update((s) => ({ ...s, spotters: (s.spotters || []).filter((sp) => sp.id !== id) }));
  const generateSpotterPin = (id) => update((s) => ({ ...s, spotters: (s.spotters || []).map((sp) => (sp.id === id ? { ...sp, pendingPin: genPin() } : sp)) }));
  const clearSpotterPin = (id) => update((s) => ({ ...s, spotters: (s.spotters || []).map((sp) => (sp.id === id ? { ...sp, pendingPin: null } : sp)) }));
  const [actingAsSpotter, setActingAsSpotter] = useState(false);

  const addTrick = () => {
    if (!newTrick.trim()) return;
    update((s) => ({ ...s, tricks: [...s.tricks, newTrick.trim()] }));
    setNewTrick("");
  };
  const [expandedHeats, setExpandedHeats] = useState({});
  const toggleExpanded = (id) => setExpandedHeats((e) => ({ ...e, [id]: !e[id] }));

  const [newPassword, setNewPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const changePassword = () => {
    if (!newPassword.trim()) return;
    update((s) => ({ ...s, adminPassword: newPassword.trim() }));
    setNewPassword("");
    setPasswordSaved(true);
    setTimeout(() => setPasswordSaved(false), 2000);
  };

  const [exportBusy, setExportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const exportCompetition = async () => {
    setExportBusy(true);
    try {
      const heatsData = {};
      for (const h of state.heats) {
        const { data } = await loadHeat(compId, h.id);
        heatsData[h.id] = data;
      }
      const bundle = { version: 1, exportedAt: new Date().toISOString(), state, heatsData };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = (state.compName || "competition").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      a.href = url;
      a.download = `${safeName}-backup.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExportBusy(false);
    }
  };

  const importCompetition = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    setImportBusy(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bundle = JSON.parse(evt.target.result);
        if (!bundle.state) throw new Error("Missing state");
        update(() => bundle.state);
        const entries = Object.entries(bundle.heatsData || {});
        for (const [heatId, data] of entries) {
          await saveHeat(compId, heatId, data);
        }
        reportStorageStatus(true);
      } catch {
        setImportError("Couldn't read that file — make sure it's a backup exported from this app.");
      } finally {
        setImportBusy(false);
      }
    };
    reader.readAsText(file);
  };

  const removeTrick = (name) => update((s) => ({ ...s, tricks: s.tricks.filter((t) => t !== name) }));
  const renameTrick = (index, newName) => {
    if (!newName.trim()) return;
    update((s) => {
      const tricks = [...s.tricks];
      tricks[index] = newName.trim();
      return { ...s, tricks };
    });
  };
  const reorderTricks = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    update((s) => {
      const tricks = [...s.tricks];
      const [moved] = tricks.splice(fromIndex, 1);
      tricks.splice(toIndex, 0, moved);
      return { ...s, tricks };
    });
  };
  const [editingTrickIndex, setEditingTrickIndex] = useState(null);
  const [dragTrickIndex, setDragTrickIndex] = useState(null);

  const [newColorName, setNewColorName] = useState("");
  const [newColorHex, setNewColorHex] = useState("#E24B4A");
  const addColor = () => {
    if (!newColorName.trim()) return;
    update((s) => ({ ...s, trikotColors: [...(s.trikotColors || []), { id: uid(), name: newColorName.trim(), hex: newColorHex }] }));
    setNewColorName("");
  };
  const quickAddColor = (name, hex) => {
    update((s) => ({ ...s, trikotColors: [...(s.trikotColors || []), { id: uid(), name, hex }] }));
  };
  const removeColor = (id) => update((s) => ({ ...s, trikotColors: (s.trikotColors || []).filter((c) => c.id !== id) }));

  const tabs = [
    { id: "plan", label: "Plan" },
    { id: "riders", label: "Riders" },
    { id: "trikots", label: "Trikots" },
    { id: "live", label: "Live control" },
    { id: "tricks", label: "Tricks" },
    { id: "judges", label: "Judges" },
    { id: "spotters", label: "Spotters" },
    { id: "backup", label: "Backup" },
  ];

  if (actingAsSpotter) {
    return <SpotterConsole state={state} onBack={() => setActingAsSpotter(false)} compId={compId} onSwitchSpotter={null} />;
  }

  return (
    <div>
      <Header title="Admin" onBack={onBack} />
      <ShareLinkCard compId={compId} />
      <div style={{ display: "flex", gap: 8, marginBottom: "1.25rem", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={btn(tab === t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "plan" && <PlanningTab state={state} update={update} />}

      {tab === "riders" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Upload roster</SectionLabel>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
              An .xlsx or .csv with a name column and a rank column. This replaces the current rider list.
            </p>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleRosterFile} />
            {uploadError && <p style={{ color: "var(--text-danger, #A32D2D)", fontSize: 13 }}>{uploadError}</p>}
            {uploadPreview && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{uploadPreview.length} riders found</p>
                {uploadWarnings.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    {uploadWarnings.map((w, i) => (
                      <div key={i} style={{ fontSize: 13, color: "var(--text-danger, #A32D2D)" }}>
                        ⚠ {w}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={btn(true)} onClick={confirmUpload}>
                    Import {uploadPreview.length} riders
                  </button>
                  <button style={btn(false)} onClick={() => setUploadPreview(null)}>Cancel</button>
                </div>
              </div>
            )}
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Add rider manually</SectionLabel>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                placeholder="Rider name"
                value={newRider}
                onChange={(e) => setNewRider(e.target.value)}
                onKeyDown={onEnter(addRider)}
                style={{ flex: 2, minWidth: 140 }}
              />
              <input
                type="number"
                placeholder="Seed rank"
                value={newRank}
                onChange={(e) => setNewRank(e.target.value)}
                onKeyDown={onEnter(addRider)}
                style={{ flex: 1, minWidth: 100 }}
              />
              <button style={btn(false)} onClick={addRider}>
                Add
              </button>
            </div>
          </Card>

          {rosterWarnings.length > 0 && (
            <Card style={{ marginBottom: 16, borderColor: "var(--border-danger, #E24B4A)" }}>
              <SectionLabel>Rank check</SectionLabel>
              {rosterWarnings.map((w, i) => (
                <div key={i} style={{ fontSize: 13, color: "var(--text-danger, #A32D2D)", marginBottom: 4 }}>
                  ⚠ {w}
                </div>
              ))}
            </Card>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {state.riders
              .slice()
              .sort((a, b) => a.rank - b.rank)
              .map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8 }}>
                  <span>
                    <span style={{ color: "var(--text-muted, #888780)", marginRight: 8 }}>#{r.rank}</span>
                    {r.name}
                  </span>
                  <IconBtn icon="Delete" onClick={() => removeRider(r.id)} label="Remove rider" />
                </div>
              ))}
            {state.riders.length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>No riders registered yet.</p>}
          </div>
        </div>
      )}

      {tab === "trikots" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Available trikot colors</SectionLabel>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
              These get assigned automatically by position within each heat (1st slot = 1st color, etc.), consistently across every heat.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {[
                { name: "Red", hex: "#E24B4A" },
                { name: "Orange", hex: "#E8853A" },
                { name: "Yellow", hex: "#E8CF3A" },
                { name: "White", hex: "#FFFFFF" },
                { name: "Green", hex: "#4C9A4C" },
                { name: "Blue", hex: "#3B7DD8" },
              ].map((c) => (
                <button key={c.name} style={{ ...btn(false), display: "flex", alignItems: "center", gap: 6 }} onClick={() => quickAddColor(c.name, c.hex)}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: c.hex, border: "0.5px solid rgba(0,0,0,0.25)" }}></span>
                  {c.name}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="color" value={newColorHex} onChange={(e) => setNewColorHex(e.target.value)} style={{ width: 44, padding: 2 }} />
              <input placeholder="Custom color name" value={newColorName} onChange={(e) => setNewColorName(e.target.value)} onKeyDown={onEnter(addColor)} style={{ flex: 1 }} />
              <button style={btn(false)} onClick={addColor}>Add</button>
            </div>
          </Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(state.trikotColors || []).map((c, i) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 4, background: c.hex, border: "0.5px solid var(--border-strong, #C7C5BC)" }}></span>
                  <span style={{ fontWeight: 500 }}>{c.name}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted, #888780)" }}>slot {i + 1}</span>
                </span>
                <IconBtn icon="Delete" onClick={() => removeColor(c.id)} label="Remove color" />
              </div>
            ))}
            {(state.trikotColors || []).length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>No colors set yet.</p>}
          </div>
        </div>
      )}

      {tab === "live" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {state.heats.map((h) => {
            const round = state.rounds.find((r) => r.id === h.roundId);
            const rids = heatRiderIds(state, h);
            const ready = rids.length === h.slots.length && h.slots.length > 0;
            return (
              <Card key={h.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontWeight: 500 }}>Heat {heatNumber(state, h.id)}</span>
                    {round && <Pill tone={ROUND_TONES[round.toneIndex]}>{round.name}</Pill>}
                  </span>
                  <Pill tone={h.status === "active" ? "accent" : h.status === "complete" ? "success" : h.status === "awaiting-variety" ? "danger" : "gray"}>{h.status}</Pill>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                  {h.slots.map((sl) => {
                    const rid = resolveSlotRider(state, sl);
                    const color = rid ? riderColorHex(state, h, rid) : null;
                    return (
                      <div key={sl.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, gap: 8, flexWrap: "wrap" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "var(--text-secondary, #5F5E5A)" }}>{slotLabel(state, sl)}</span>
                          {rid && <RiderChip name={riderName(state, rid)} color={color} size={12} />}
                        </span>
                        <div style={{ display: "flex", gap: 6 }}>
                          {(state.trikotColors || []).length > 0 && (
                            <select value={sl.colorOverride || ""} onChange={(e) => setSlotColor(h.id, sl.id, e.target.value)} style={{ fontSize: 12 }}>
                              <option value="">Trikot: auto</option>
                              {state.trikotColors.map((c) => (
                                <option key={c.id} value={c.id}>
                                  Trikot: {c.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <select value={sl.override || ""} onChange={(e) => setOverride(h.id, sl.id, e.target.value)} style={{ fontSize: 13 }}>
                            <option value="">{rid ? riderName(state, rid) : "TBD"}</option>
                            {state.riders.map((r) => (
                              <option key={r.id} value={r.id}>
                                Override: {r.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {h.status !== "active" && h.status !== "complete" && (
                    <button style={btn(false)} onClick={() => setHeatStatus(h.id, "active")} disabled={!ready}>
                      Start heat
                    </button>
                  )}
                  {h.status === "active" && (
                    <button style={btn(false)} onClick={() => setHeatStatus(h.id, "awaiting-variety")}>
                      End heat, collect variety
                    </button>
                  )}
                  {h.status === "awaiting-variety" && (
                    <button style={btn(false)} onClick={() => finalizeHeat(h)}>
                      Finalize heat
                    </button>
                  )}
                  {h.status === "complete" && <button style={btn(false)} onClick={() => setHeatStatus(h.id, "pending")}>Reopen</button>}
                  <button style={{ ...btn(false), marginLeft: "auto" }} onClick={() => toggleExpanded(h.id)}>
                    {expandedHeats[h.id] ? "Hide entries" : "Show entries"}
                  </button>
                </div>
                {!ready && h.status === "pending" && <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", marginTop: 8, marginBottom: 0 }}>Waiting on riders to be resolved.</p>}
                {h.status === "awaiting-variety" && <VarietyStatus state={state} heat={h} compId={compId} />}
                {expandedHeats[h.id] && <HeatEntriesPanel state={state} heat={h} compId={compId} />}
              </Card>
            );
          })}
          {state.heats.length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>Plan the competition first.</p>}
        </div>
      )}

      {tab === "tricks" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input placeholder="New trick name" value={newTrick} onChange={(e) => setNewTrick(e.target.value)} onKeyDown={onEnter(addTrick)} style={{ flex: 1 }} />
              <button style={btn(false)} onClick={addTrick}>
                Add
              </button>
            </div>
          </Card>
          <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", marginTop: 0, marginBottom: 10 }}>Drag to reorder. Click a name to rename it.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {state.tricks.map((t, i) => (
              <span
                key={i}
                draggable
                onDragStart={() => setDragTrickIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTrickIndex !== null) reorderTricks(dragTrickIndex, i);
                  setDragTrickIndex(null);
                }}
                onDragEnd={() => setDragTrickIndex(null)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 6px 5px 12px",
                  border: "0.5px solid var(--border, #D9D7CE)",
                  borderRadius: 999,
                  fontSize: 13,
                  background: dragTrickIndex === i ? "var(--surface-1, #F1EFE8)" : "transparent",
                  cursor: "grab",
                }}
              >
                <span style={{ color: "var(--text-muted, #888780)", fontSize: 12 }}>⠿</span>
                {editingTrickIndex === i ? (
                  <input
                    id={`trick-rename-${i}`}
                    defaultValue={t}
                    autoFocus
                    style={{ fontSize: 13, width: 120 }}
                    onKeyDown={onEnter(() => {
                      const el = document.getElementById(`trick-rename-${i}`);
                      if (el) renameTrick(i, el.value);
                      setEditingTrickIndex(null);
                    })}
                    onBlur={(e) => {
                      renameTrick(i, e.target.value);
                      setEditingTrickIndex(null);
                    }}
                  />
                ) : (
                  <button onClick={() => setEditingTrickIndex(i)} style={{ border: "none", background: "none", padding: 0, fontSize: 13, cursor: "pointer" }}>
                    {t}
                  </button>
                )}
                <button onClick={() => removeTrick(t)} aria-label={`Remove ${t}`} style={{ padding: "0 2px", border: "none", background: "none", fontSize: 14, color: "var(--text-danger, #A32D2D)", cursor: "pointer" }}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {tab === "judges" && (
        <div>
          <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0, marginBottom: 14 }}>
            When a judge picks their name on their phone, generate a code here and read it out to them in person —
            that's what lets them in. Their phone then stays logged in on its own even if the browser closes by
            accident, so you only need to do this once per judge per device.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {state.judges.length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>No judges have registered yet.</p>}
            {state.judges.map((j) => (
              <div key={j.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8, flexWrap: "wrap", gap: 8 }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {j.name} <Pill tone={j.status === "approved" ? "success" : "gray"}>{j.status}</Pill>
                  {j.pendingPin && (
                    <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-accent, #185FA5)" }}>{j.pendingPin}</span>
                  )}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={btn(false)} onClick={() => generateJudgePin(j.id)}>
                    {j.pendingPin ? "New code" : "Generate code"}
                  </button>
                  {j.pendingPin && (
                    <button style={btn(false)} onClick={() => clearJudgePin(j.id)}>Hide</button>
                  )}
                  <IconBtn icon="Delete" onClick={() => removeJudge(j.id)} label="Remove judge" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "spotters" && (
        <div>
          <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0, marginBottom: 14 }}>
            Same idea as judges — spotters need an admin-issued code to get in, so an audience member can't
            pretend to be a spotter and spam the judges or burn through riders' trick attempts. You (the admin) can
            always act as a spotter yourself without any of this — see the button below.
          </p>
          <button style={{ ...btn(true), marginBottom: 16 }} onClick={() => setActingAsSpotter(true)}>
            Act as spotter (no approval needed)
          </button>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(state.spotters || []).length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>No spotters have registered yet.</p>}
            {(state.spotters || []).map((sp) => (
              <div key={sp.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8, flexWrap: "wrap", gap: 8 }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {sp.name} <Pill tone={sp.status === "approved" ? "success" : "gray"}>{sp.status}</Pill>
                  {sp.pendingPin && (
                    <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-accent, #185FA5)" }}>{sp.pendingPin}</span>
                  )}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={btn(false)} onClick={() => generateSpotterPin(sp.id)}>
                    {sp.pendingPin ? "New code" : "Generate code"}
                  </button>
                  {sp.pendingPin && (
                    <button style={btn(false)} onClick={() => clearSpotterPin(sp.id)}>Hide</button>
                  )}
                  <IconBtn icon="Delete" onClick={() => removeSpotter(sp.id)} label="Remove spotter" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "backup" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Admin password</SectionLabel>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
              Required to open the Admin role. Change it any time.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={onEnter(changePassword)}
                style={{ flex: 1 }}
              />
              <button style={btn(false)} onClick={changePassword}>Set</button>
            </div>
            {passwordSaved && <p style={{ fontSize: 13, color: "var(--text-success, #3B6D11)", marginTop: 8, marginBottom: 0 }}>Password updated.</p>}
            <button onClick={onForgetDevice} style={{ ...btn(false), fontSize: 12, marginTop: 12 }}>
              Forget saved password on this device
            </button>
          </Card>
          <Card style={{ marginBottom: 16 }}>
            <SectionLabel>Export</SectionLabel>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
              Downloads everything — riders, rounds, heats, trikots, every trick logged, every score — as one JSON file you keep on your own laptop.
            </p>
            <button style={btn(true)} onClick={exportCompetition} disabled={exportBusy}>
              {exportBusy ? "Preparing…" : "Download backup"}
            </button>
          </Card>
          <Card>
            <SectionLabel>Import / restore</SectionLabel>
            <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
              Restores a backup into this competition, overwriting whatever is currently here.
            </p>
            <input type="file" accept=".json" onChange={importCompetition} disabled={importBusy} />
            {importBusy && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>Restoring…</p>}
            {importError && <p style={{ fontSize: 13, color: "var(--text-danger, #A32D2D)" }}>{importError}</p>}
          </Card>
        </div>
      )}
    </div>
  );
}

function closestTricks(text, tricks, n = 3) {
  const norm = (s) => s.toLowerCase();
  const targetWords = norm(text).split(/\s+/).filter(Boolean);
  return tricks
    .map((tr) => {
      const trWords = norm(tr).split(/\s+/);
      const score = trWords.reduce((acc, w) => acc + (targetWords.includes(w) ? 1 : 0), 0);
      return { tr, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.tr);
}

const SpeechRecognitionCtor =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function SpotterConsole({ state, onBack, compId, onSwitchSpotter }) {
  const liveHeats = state.heats.filter((h) => h.status === "active");
  const [heatId, setHeatId] = useState(liveHeats[0]?.id || "");
  const [selectedRider, setSelectedRider] = useState(null);
  const [selectedSide, setSelectedSide] = useState(null);
  const [comboTags, setComboTags] = useState([]);
  const [customTrick, setCustomTrick] = useState("");
  const [sentFlash, setSentFlash] = useState(null);
  const [data, updateHeat] = useHeatData(compId, heatId);
  const [listening, setListening] = useState(false);
  const [voiceCandidate, setVoiceCandidate] = useState("");
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (!heatId && liveHeats[0]) setHeatId(liveHeats[0].id);
  }, [liveHeats, heatId]);

  const heat = state.heats.find((h) => h.id === heatId);
  const riderIds = heat ? heatRiderIds(state, heat) : [];
  const round = heat ? state.rounds.find((r) => r.id === heat.roundId) : null;
  const maxAttempts = round?.maxAttempts || null;
  const attemptCounts = {};
  (data.log || []).forEach((e) => {
    attemptCounts[e.riderId] = (attemptCounts[e.riderId] || 0) + 1;
  });

  const sendTrick = (trickPart) => {
    if (!selectedRider || !selectedSide || !trickPart) return;
    const fullTrick = `${selectedSide} ${trickPart}`.trim();
    updateHeat((d) => ({
      ...d,
      log: [...(d.log || []), { id: uid(), riderId: selectedRider, trick: fullTrick, ts: Date.now(), scores: {} }],
    }));
    setSentFlash(`${riderName(state, selectedRider)} — ${fullTrick}`);
    setSelectedRider(null);
    setSelectedSide(null);
    setComboTags([]);
    setCustomTrick("");
    setVoiceCandidate("");
    setTimeout(() => setSentFlash(null), 2000);
  };

  const toggleTag = (tag) => setComboTags((tags) => (tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]));
  const comboName = state.tricks.filter((t) => comboTags.includes(t)).join(" ");
  const canPickTrick = selectedRider && selectedSide;

  const startListening = () => {
    if (!SpeechRecognitionCtor || !canPickTrick || listening) return;
    const rec = new SpeechRecognitionCtor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      setVoiceCandidate(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };
  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  if (liveHeats.length === 0) {
    return (
      <div>
        <Header title="Spotter" onBack={onBack} />
        {onSwitchSpotter && <button onClick={onSwitchSpotter} style={{ ...btn(false), fontSize: 12, marginBottom: 12 }}>Not you? Switch spotter</button>}
        <p style={{ color: "var(--text-muted, #888780)" }}>No heat is currently active. Ask the admin to start one.</p>
      </div>
    );
  }

  return (
    <div>
      <Header title="Spotter" onBack={onBack} />
      {onSwitchSpotter && <button onClick={onSwitchSpotter} style={{ ...btn(false), fontSize: 12, marginBottom: 12 }}>Not you? Switch spotter</button>}
      {liveHeats.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {liveHeats.map((h) => (
            <button key={h.id} onClick={() => { setHeatId(h.id); setSelectedRider(null); setSelectedSide(null); }} style={btn(heatId === h.id)}>
              Heat {heatNumber(state, h.id)}
            </button>
          ))}
        </div>
      )}
      {sentFlash && (
        <div style={{ marginBottom: 12 }}>
          <Pill tone="success">Sent: {sentFlash}</Pill>
        </div>
      )}
      <SectionLabel>1. Rider</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
        {riderIds.map((rid) => {
          const color = heat ? riderColorHex(state, heat, rid) : null;
          const count = attemptCounts[rid] || 0;
          const outOfAttempts = maxAttempts && count >= maxAttempts;
          return (
            <button
              key={rid}
              onClick={() => !outOfAttempts && setSelectedRider(rid)}
              disabled={outOfAttempts}
              style={{ ...btn(selectedRider === rid), display: "flex", alignItems: "center", gap: 8, opacity: outOfAttempts ? 0.4 : 1 }}
            >
              {color && <span style={{ width: 12, height: 12, borderRadius: "50%", background: color, border: "0.5px solid rgba(0,0,0,0.25)", flexShrink: 0 }}></span>}
              {riderName(state, rid)}
              {outOfAttempts && <span style={{ fontSize: 11 }}> (out of attempts)</span>}
            </button>
          );
        })}
      </div>

      <SectionLabel>2. Side</SectionLabel>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, opacity: selectedRider ? 1 : 0.5 }}>
        {["Left", "Right"].map((side) => (
          <button key={side} disabled={!selectedRider} onClick={() => setSelectedSide(side)} style={{ ...btn(selectedSide === side), flex: 1, padding: "12px 0" }}>
            {side}
          </button>
        ))}
      </div>

      <SectionLabel>3. Trick</SectionLabel>

      {SpeechRecognitionCtor && (
        <div style={{ marginBottom: 12 }}>
          <button
            style={{ ...btn(listening), opacity: canPickTrick ? 1 : 0.5 }}
            disabled={!canPickTrick}
            onClick={listening ? stopListening : startListening}
          >
            {listening ? "● Listening… tap to stop" : "🎙 Speak trick"}
          </button>
        </div>
      )}

      {voiceCandidate && (
        <Card style={{ marginBottom: 14, borderColor: "var(--border-accent, #378ADD)" }}>
          <p style={{ margin: "0 0 8px 0", fontSize: 13, color: "var(--text-secondary, #5F5E5A)" }}>Heard:</p>
          <p style={{ margin: "0 0 10px 0", fontWeight: 500 }}>"{voiceCandidate}"</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <button style={btn(true)} onClick={() => sendTrick(voiceCandidate)}>Send as heard</button>
            <button style={btn(false)} onClick={() => setVoiceCandidate("")}>Discard</button>
          </div>
          {closestTricks(voiceCandidate, state.tricks).length > 0 && (
            <div>
              <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", margin: "0 0 6px 0" }}>Did you mean:</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {closestTricks(voiceCandidate, state.tricks).map((t) => (
                  <button key={t} style={btn(false)} onClick={() => sendTrick(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, opacity: canPickTrick ? 1 : 0.5 }}>
        {state.tricks.map((t) => (
          <button key={t} disabled={!canPickTrick} onClick={() => toggleTag(t)} style={btn(comboTags.includes(t))}>
            {t}
          </button>
        ))}
      </div>
      {comboTags.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontWeight: 500 }}>{selectedSide} {comboName}</span>
          <button style={btn(true)} onClick={() => sendTrick(comboName)}>Send</button>
          <button style={btn(false)} onClick={() => setComboTags([])}>Clear</button>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input placeholder="Custom trick" value={customTrick} onChange={(e) => setCustomTrick(e.target.value)} disabled={!canPickTrick} style={{ flex: 1 }} />
        <button style={btn(false)} disabled={!canPickTrick || !customTrick.trim()} onClick={() => sendTrick(customTrick.trim())}>
          Send
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionLabel>Recent log</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(data.log || []).slice().reverse().slice(0, 8).map((e) => (
            <div key={e.id} style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)" }}>
              <RiderChip name={riderName(state, e.riderId)} color={heat && riderColorHex(state, heat, e.riderId)} /> — {e.trick}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function genPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function SpotterView({ state, update, onBack, compId }) {
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [pickedSpotterId, setPickedSpotterId] = useState(null);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [newName, setNewName] = useState("");
  const spotterKey = `kite-comp:my-spotter:${compId}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(spotterKey);
      if (raw) setProfile(JSON.parse(raw));
    } catch {}
    setProfileLoaded(true);
  }, [spotterKey]);

  const switchSpotter = () => {
    try {
      localStorage.removeItem(spotterKey);
    } catch {}
    setProfile(null);
    setPickedSpotterId(null);
    setPinInput("");
    setPinError("");
  };

  const registerNewSpotter = () => {
    if (!newName.trim()) return;
    const sp = { id: uid(), name: newName.trim(), status: "pending", pendingPin: null };
    update((s) => ({ ...s, spotters: [...(s.spotters || []), sp] }));
    setPickedSpotterId(sp.id);
    setNewName("");
  };

  const submitPin = () => {
    const sp = (state.spotters || []).find((x) => x.id === pickedSpotterId);
    if (!sp) return;
    if (!sp.pendingPin || pinInput.trim() !== sp.pendingPin) {
      setPinError("That code doesn't match. Ask the admin for the current one.");
      return;
    }
    const authed = { id: sp.id, name: sp.name };
    setProfile(authed);
    try {
      localStorage.setItem(spotterKey, JSON.stringify(authed));
    } catch {}
    update((s) => ({ ...s, spotters: (s.spotters || []).map((x) => (x.id === sp.id ? { ...x, status: "approved", pendingPin: null } : x)) }));
    setPickedSpotterId(null);
    setPinInput("");
    setPinError("");
  };

  if (!profileLoaded) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888780)" }}>Loading…</div>;
  }

  if (profile) {
    const liveSpotter = (state.spotters || []).find((x) => x.id === profile.id);
    if (liveSpotter && liveSpotter.status === "approved") {
      return <SpotterConsole state={state} onBack={onBack} compId={compId} onSwitchSpotter={switchSpotter} />;
    }
  }

  if (pickedSpotterId) {
    const sp = (state.spotters || []).find((x) => x.id === pickedSpotterId);
    return (
      <div>
        <Header title="Spotter" onBack={onBack} />
        <Card>
          <SectionLabel>Access code for {sp ? sp.name : "you"}</SectionLabel>
          <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
            Ask the admin for the code — it's shown on their screen next to your name.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={onEnter(submitPin)}
              placeholder="Access code"
              inputMode="numeric"
              style={{ flex: 1 }}
            />
            <button style={btn(true)} onClick={submitPin}>Unlock</button>
          </div>
          {pinError && <p style={{ color: "var(--text-danger, #A32D2D)", fontSize: 13, marginTop: 8, marginBottom: 0 }}>{pinError}</p>}
          <button onClick={() => setPickedSpotterId(null)} style={{ ...btn(false), fontSize: 12, marginTop: 10 }}>← Not me, pick again</button>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Header title="Spotter" onBack={onBack} />
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Who are you?</SectionLabel>
        {(state.spotters || []).length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>No spotters registered yet — add your name below.</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(state.spotters || []).map((sp) => (
            <button key={sp.id} onClick={() => setPickedSpotterId(sp.id)} style={btn(false)}>
              {sp.name}
            </button>
          ))}
        </div>
      </Card>
      <Card>
        <SectionLabel>Not on the list</SectionLabel>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onEnter(registerNewSpotter)} placeholder="Your name" style={{ flex: 1 }} />
          <button style={btn(false)} onClick={registerNewSpotter}>Register</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", marginTop: 10, marginBottom: 0 }}>
          The admin will need to give you an access code either way — this just adds your name so they can generate one.
        </p>
      </Card>
    </div>
  );
}

function JudgeView({ state, update, onBack, compId }) {
  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [pickedJudgeId, setPickedJudgeId] = useState(null);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState("");
  const [newName, setNewName] = useState("");
  const judgeKey = `kite-comp:my-judge:${compId}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(judgeKey);
      if (raw) setProfile(JSON.parse(raw));
    } catch {}
    setProfileLoaded(true);
  }, [judgeKey]);

  const switchJudge = () => {
    try {
      localStorage.removeItem(judgeKey);
    } catch {}
    setProfile(null);
    setPickedJudgeId(null);
    setPinInput("");
    setPinError("");
  };

  const registerNewJudge = () => {
    if (!newName.trim()) return;
    const j = { id: uid(), name: newName.trim(), status: "pending", pendingPin: null };
    update((s) => ({ ...s, judges: [...s.judges, j] }));
    setPickedJudgeId(j.id);
    setNewName("");
  };

  const submitPin = () => {
    const j = state.judges.find((x) => x.id === pickedJudgeId);
    if (!j) return;
    if (!j.pendingPin || pinInput.trim() !== j.pendingPin) {
      setPinError("That code doesn't match. Ask the admin for the current one.");
      return;
    }
    const authed = { id: j.id, name: j.name };
    setProfile(authed);
    try {
      localStorage.setItem(judgeKey, JSON.stringify(authed));
    } catch {}
    update((s) => ({ ...s, judges: s.judges.map((x) => (x.id === j.id ? { ...x, status: "approved", pendingPin: null } : x)) }));
    setPickedJudgeId(null);
    setPinInput("");
    setPinError("");
  };

  if (!profileLoaded) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888780)" }}>Loading…</div>;
  }

  // Already authenticated on this device — skip straight in, even after an accidental
  // browser close, as long as the judge still exists on the roster.
  if (profile) {
    const liveJudge = state.judges.find((j) => j.id === profile.id);
    if (liveJudge && liveJudge.status === "approved") {
      return <JudgeScoring state={state} judge={liveJudge} onBack={onBack} compId={compId} onSwitchJudge={switchJudge} />;
    }
    // Roster entry vanished or was reset — fall through to re-pick.
  }

  // Picked a name and waiting on the admin-issued code.
  if (pickedJudgeId) {
    const j = state.judges.find((x) => x.id === pickedJudgeId);
    return (
      <div>
        <Header title="Judge" onBack={onBack} />
        <Card>
          <SectionLabel>Access code for {j ? j.name : "you"}</SectionLabel>
          <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
            Ask the admin standing with you for the code — it's shown on their screen next to your name.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={onEnter(submitPin)}
              placeholder="Access code"
              inputMode="numeric"
              style={{ flex: 1 }}
            />
            <button style={btn(true)} onClick={submitPin}>Unlock</button>
          </div>
          {pinError && <p style={{ color: "var(--text-danger, #A32D2D)", fontSize: 13, marginTop: 8, marginBottom: 0 }}>{pinError}</p>}
          <button onClick={() => setPickedJudgeId(null)} style={{ ...btn(false), fontSize: 12, marginTop: 10 }}>← Not me, pick again</button>
        </Card>
      </div>
    );
  }

  // Nothing picked yet — show the roster to choose from, or register a new name.
  return (
    <div>
      <Header title="Judge" onBack={onBack} />
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Who are you?</SectionLabel>
        {state.judges.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>No judges registered yet — add your name below.</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {state.judges.map((j) => (
            <button key={j.id} onClick={() => setPickedJudgeId(j.id)} style={btn(false)}>
              {j.name}
            </button>
          ))}
        </div>
      </Card>
      <Card>
        <SectionLabel>Not on the list</SectionLabel>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onEnter(registerNewJudge)} placeholder="Your name" style={{ flex: 1 }} />
          <button style={btn(false)} onClick={registerNewJudge}>Register</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted, #888780)", marginTop: 10, marginBottom: 0 }}>
          The admin will need to give you an access code either way — this just adds your name so they can generate one.
        </p>
      </Card>
    </div>
  );
}

function JudgeScoring({ state, judge, onBack, compId, onSwitchJudge }) {
  const relevantHeats = state.heats.filter((h) => h.status === "active" || h.status === "awaiting-variety");
  const [heatId, setHeatId] = useState(relevantHeats[0]?.id || "");
  useEffect(() => {
    if (!relevantHeats.find((h) => h.id === heatId) && relevantHeats[0]) setHeatId(relevantHeats[0].id);
  }, [relevantHeats, heatId]);

  const heat = state.heats.find((h) => h.id === heatId);
  const riderIds = heat ? heatRiderIds(state, heat) : [];
  const [data, updateHeat] = useHeatData(compId, heatId);
  const [lastScored, setLastScored] = useState(null);
  const [viewMode, setViewMode] = useState("pending");

  if (relevantHeats.length === 0) {
    return (
      <div>
        <Header title={`Judge — ${judge.name}`} onBack={onBack} />
        <p style={{ color: "var(--text-muted, #888780)" }}>No heat is live right now.</p>
        <button onClick={onSwitchJudge} style={{ ...btn(false), fontSize: 12, marginTop: 10 }}>Not you? Switch judge</button>
      </div>
    );
  }

  const scoreTrick = (entryId, value) => {
    updateHeat((d) => ({
      ...d,
      log: (d.log || []).map((e) => (e.id === entryId ? { ...e, scores: { ...e.scores, [judge.id]: value } } : e)),
    }));
  };
  const clearOwnScore = (entryId) => {
    updateHeat((d) => ({
      ...d,
      log: (d.log || []).map((e) => {
        if (e.id !== entryId) return e;
        const scores = { ...e.scores };
        delete scores[judge.id];
        return { ...e, scores };
      }),
    }));
  };
  const undoLast = () => {
    if (!lastScored) return;
    clearOwnScore(lastScored.id);
    setLastScored(null);
  };

  const submitVariety = () => {
    const values = {};
    for (const rid of riderIds) {
      const el = document.getElementById(`variety-input-${rid}`);
      const val = el ? el.value : "";
      if (val === "") return;
      values[rid] = Number(val);
    }
    updateHeat((d) => {
      const variety = { ...(d.variety || {}) };
      riderIds.forEach((rid) => {
        variety[rid] = { ...(variety[rid] || {}), [judge.id]: values[rid] };
      });
      return { ...d, variety };
    });
  };

  const alreadySubmittedVariety = riderIds.length > 0 && riderIds.every((rid) => (data.variety || {})[rid]?.[judge.id] !== undefined);
  const pendingEntries = (data.log || []).filter((e) => e.scores[judge.id] === undefined && !isCrash(e.trick)).slice().reverse();
  const allEntries = (data.log || []).slice().reverse();
  const visibleEntries = viewMode === "pending" ? pendingEntries : allEntries;

  return (
    <div>
      <Header title={`Judge — ${judge.name}`} onBack={onBack} />
      <button onClick={onSwitchJudge} style={{ ...btn(false), fontSize: 12, marginBottom: 12 }}>Not you? Switch judge</button>
      {relevantHeats.length > 1 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {relevantHeats.map((h) => (
            <button key={h.id} onClick={() => setHeatId(h.id)} style={btn(heatId === h.id)}>
              Heat {heatNumber(state, h.id)}
            </button>
          ))}
        </div>
      )}

      {heat?.status === "awaiting-variety" ? (
        <Card>
          <SectionLabel>Variety score — heat {heatNumber(state, heat.id)}</SectionLabel>
          {alreadySubmittedVariety ? (
            <p style={{ color: "var(--text-secondary, #5F5E5A)" }}>Submitted. Thanks.</p>
          ) : (
            <>
              {riderIds.map((rid) => {
                const { left, right, neutral } = riderTrickBreakdown(data, rid);
                return (
                  <div key={rid} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: "0.5px solid var(--border, #D9D7CE)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <RiderChip name={riderName(state, rid)} color={heat && riderColorHex(state, heat, rid)} />
                      <input
                        id={`variety-input-${rid}`}
                        type="number"
                        min="0"
                        max="10"
                        step="0.5"
                        style={{ width: 80 }}
                      />
                    </div>
                    <p style={{ fontSize: 13, margin: "2px 0", color: "var(--text-secondary, #5F5E5A)" }}>
                      <strong>Left:</strong> {left.length ? left.join(", ") : "—"}
                    </p>
                    <p style={{ fontSize: 13, margin: "2px 0", color: "var(--text-secondary, #5F5E5A)" }}>
                      <strong>Right:</strong> {right.length ? right.join(", ") : "—"}
                    </p>
                    {neutral.length > 0 && (
                      <p style={{ fontSize: 13, margin: "2px 0", color: "var(--text-muted, #888780)" }}>
                        Other: {neutral.join(", ")}
                      </p>
                    )}
                  </div>
                );
              })}
              <button style={btn(true)} onClick={submitVariety}>Submit variety scores</button>
            </>
          )}
        </Card>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button style={btn(viewMode === "pending")} onClick={() => setViewMode("pending")}>Pending</button>
            <button style={btn(viewMode === "all")} onClick={() => setViewMode("all")}>All my scores</button>
            {lastScored && (
              <button style={{ ...btn(false), marginLeft: "auto" }} onClick={undoLast}>
                Undo: {riderName(state, lastScored.riderId)} — {lastScored.trick}
              </button>
            )}
          </div>
          {visibleEntries.length === 0 && (
            <p style={{ color: "var(--text-muted, #888780)" }}>
              {viewMode === "pending" ? "No tricks waiting for your score." : "No tricks logged in this heat yet."}
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {visibleEntries.map((e, idx) => {
              const crash = isCrash(e.trick);
              const myScore = e.scores[judge.id];
              const submit = () => {
                const el = document.getElementById(`score-${e.id}`);
                if (!el || el.value === "") return;
                scoreTrick(e.id, Number(el.value));
                setLastScored({ id: e.id, riderId: e.riderId, trick: e.trick });
                if (viewMode === "pending") {
                  const next = visibleEntries[idx + 1];
                  if (next) {
                    setTimeout(() => {
                      const nextEl = document.getElementById(`score-${next.id}`);
                      if (nextEl) nextEl.focus();
                    }, 60);
                  }
                }
              };
              return (
                <Card key={e.id}>
                  <p style={{ margin: "0 0 10px 0", fontWeight: 500 }}>
                    <RiderChip name={riderName(state, e.riderId)} color={heat && riderColorHex(state, heat, e.riderId)} /> — {e.trick}
                    {viewMode === "all" && !crash && (
                      <span style={{ fontSize: 12, color: "var(--text-muted, #888780)", marginLeft: 8 }}>
                        your score: {myScore === "skip" ? "skip" : myScore === undefined ? "not yet" : myScore}
                      </span>
                    )}
                  </p>
                  {crash ? (
                    <div
                      style={{
                        display: "inline-block",
                        padding: "6px 14px",
                        borderRadius: 8,
                        background: "var(--bg-danger, #FCEBEB)",
                        color: "var(--text-danger, #A32D2D)",
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        fontSize: 13,
                      }}
                    >
                      CRASH — 0 points, counts as an attempt
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.5"
                        placeholder="Score"
                        defaultValue={typeof myScore === "number" ? myScore : ""}
                        style={{ width: 90 }}
                        id={`score-${e.id}`}
                        key={`score-input-${e.id}-${myScore}`}
                        onKeyDown={onEnter(submit)}
                      />
                      <button style={btn(false)} onClick={submit}>
                        {viewMode === "all" && myScore !== undefined ? "Update" : "Submit"}
                      </button>
                      <button
                        style={{ ...btn(false), marginLeft: "auto" }}
                        onClick={() => {
                          scoreTrick(e.id, "skip");
                          setLastScored({ id: e.id, riderId: e.riderId, trick: e.trick });
                        }}
                      >
                        Didn't see it
                      </button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LeaderboardView({ state, onBack, compId, focusHeatId }) {
  const heatsWithActivity = state.heats.filter((h) => h.status !== "pending");
  const [heatId, setHeatId] = useState(focusHeatId || heatsWithActivity[0]?.id || "");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    if (focusHeatId && heatsWithActivity.find((h) => h.id === focusHeatId)) setHeatId(focusHeatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusHeatId]);
  useEffect(() => {
    if (!heatsWithActivity.find((h) => h.id === heatId) && heatsWithActivity[0]) setHeatId(heatsWithActivity[0].id);
  }, [heatsWithActivity, heatId]);

  const [data] = useHeatData(compId, heatId);
  const heat = state.heats.find((h) => h.id === heatId);
  const riderIds = heat ? heatRiderIds(state, heat) : [];

  if (heatsWithActivity.length === 0) {
    return (
      <div>
        <Header title="Leaderboard" onBack={onBack} />
        <p style={{ color: "var(--text-muted, #888780)" }}>No heat has started yet.</p>
      </div>
    );
  }

  const rows = riderIds.map((rid) => ({ rid, ...riderTotal(data, rid) })).sort((a, b) => b.total - a.total);

  const topIdsFor = (rid) => {
    const entries = (data.log || []).filter((e) => e.riderId === rid);
    const scored = entries.map((e) => ({ id: e.id, score: trickScore(e) })).filter((e) => e.score !== null);
    scored.sort((a, b) => b.score - a.score);
    return new Set(scored.slice(0, 3).map((e) => e.id));
  };

  return (
    <div>
      <Header title="Leaderboard" onBack={onBack} />
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {heatsWithActivity.map((h) => (
          <button key={h.id} onClick={() => { setHeatId(h.id); setExpanded(null); }} style={btn(heatId === h.id)}>
            Heat {heatNumber(state, h.id)} {h.status === "active" && <span style={{ fontSize: 11 }}> · live</span>}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((r, i) => {
          const topIds = topIdsFor(r.rid);
          const entries = (data.log || [])
            .filter((e) => e.riderId === r.rid)
            .map((e) => ({ ...e, _score: trickScore(e) }))
            .sort((a, b) => (b._score ?? -1) - (a._score ?? -1));
          const color = heat && riderColorHex(state, heat, r.rid);
          return (
            <div
              key={r.rid}
              style={{
                padding: "12px 16px",
                border: "0.5px solid var(--border, #D9D7CE)",
                borderRadius: 10,
                background: i === 0 && r.hasAnyScore ? "var(--bg-accent-muted, #EAF1FB)" : "var(--surface-2, #FFFFFF)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: entries.length ? 8 : 0, flexWrap: "wrap", gap: 6 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ color: "var(--text-muted, #888780)", width: 20, fontWeight: 500 }}>{i + 1}</span>
                  <RiderChip name={riderName(state, r.rid)} color={color} />
                </span>
                <span style={{ fontSize: 14, color: "var(--text-secondary, #5F5E5A)" }}>
                  {r.hasAnyScore ? (
                    <>
                      <strong style={{ color: "var(--text-primary, #2C2C2A)" }}>{round1(r.total)}</strong>
                      {" · best3 "}
                      {round1(r.sumTop3)}
                      {r.variety !== null ? ` · variety ${round1(r.variety)}` : " · variety pending"}
                    </>
                  ) : (
                    "No scores yet"
                  )}
                </span>
              </div>
              {entries.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {entries.map((e) => {
                    const counted = topIds.has(e.id);
                    const crash = isCrash(e.trick);
                    const isOpen = expanded === e.id;
                    return (
                      <div key={e.id}>
                        <button
                          onClick={() => setExpanded(isOpen ? null : e.id)}
                          style={{
                            fontSize: 13,
                            fontWeight: counted ? 700 : 500,
                            padding: "4px 10px",
                            borderRadius: 999,
                            border: `1px solid ${counted ? "var(--border-accent, #378ADD)" : "var(--border, #D9D7CE)"}`,
                            background: crash ? "var(--bg-danger, #FCEBEB)" : counted ? "var(--bg-accent, #E6F1FB)" : "var(--surface-1, #F1EFE8)",
                            color: crash ? "var(--text-danger, #A32D2D)" : counted ? "var(--text-accent, #185FA5)" : "var(--text-secondary, #5F5E5A)",
                            cursor: "pointer",
                          }}
                        >
                          {crash ? "CRASH" : e._score === null ? "…" : round1(e._score)}
                        </button>
                        {isOpen && (
                          <div style={{ marginTop: 4, marginBottom: 4, padding: "8px 10px", background: "var(--surface-1, #F1EFE8)", borderRadius: 8, fontSize: 12 }}>
                            <p style={{ margin: 0, fontWeight: 500 }}>
                              {e.trick}
                              {!crash && (
                                <span style={{ fontWeight: 400, color: "var(--text-secondary, #5F5E5A)", marginLeft: 8 }}>
                                  {e._score === null ? "no scores yet" : `${round1(e._score)} avg`}
                                </span>
                              )}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function contrastText(hex) {
  if (!hex) return null;
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}
function RiderChip({ name, color, size = 13 }) {
  if (!color) return <span style={{ fontWeight: 500, fontSize: size }}>{name}</span>;
  return (
    <span
      style={{
        display: "inline-block",
        background: color,
        color: contrastText(color),
        fontWeight: 600,
        fontSize: size,
        padding: "2px 8px",
        borderRadius: 6,
        border: "0.5px solid rgba(0,0,0,0.15)",
      }}
    >
      {name}
    </span>
  );
}

function BracketHeatTable({ state, heat, compId, onViewHeat }) {
  const [data] = useHeatData(compId, heat.id, 10000);
  const rids = heatRiderIds(state, heat);
  const rows = rids.map((rid) => ({ rid, color: riderColorHex(state, heat, rid), ...riderTotal(data, rid) }));
  const anyScored = rows.some((r) => r.hasAnyScore);
  const sorted = anyScored ? rows.slice().sort((a, b) => b.total - a.total) : rows;
  const tbdCount = heat.slots.length - rids.length;
  const isLive = heat.status === "active" || heat.status === "awaiting-variety";

  return (
    <div
      onClick={isLive ? () => onViewHeat(heat.id) : undefined}
      style={{
        minWidth: 220,
        border: `0.5px solid ${isLive ? "var(--border-accent, #378ADD)" : "var(--border, #D9D7CE)"}`,
        borderRadius: 10,
        overflow: "hidden",
        flexShrink: 0,
        cursor: isLive ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "var(--surface-1, #F1EFE8)" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Heat {heatNumber(state, heat.id)}</span>
        <Pill tone={heat.status === "active" ? "accent" : heat.status === "complete" ? "success" : heat.status === "awaiting-variety" ? "danger" : "gray"}>{heat.status}</Pill>
      </div>
      <div>
        {sorted.map((r) => (
          <div
            key={r.rid}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "7px 12px",
              background: r.color || "var(--surface-2, #FFFFFF)",
              color: contrastText(r.color) || "var(--text-primary, #2C2C2A)",
              borderTop: "0.5px solid rgba(0,0,0,0.08)",
            }}
          >
            <span style={{ fontWeight: 500, fontSize: 13 }}>{riderName(state, r.rid)}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{r.hasAnyScore ? round1(r.total) : "—"}</span>
          </div>
        ))}
        {heat.slots.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted, #888780)" }}>No slots defined</div>}
        {tbdCount > 0 && <div style={{ padding: "7px 12px", fontSize: 12, color: "var(--text-muted, #888780)", borderTop: "0.5px solid var(--border, #D9D7CE)" }}>{tbdCount} TBD</div>}
        {isLive && <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-accent, #185FA5)", borderTop: "0.5px solid var(--border, #D9D7CE)", textAlign: "center" }}>Tap for live scores →</div>}
      </div>
    </div>
  );
}

function BracketView({ state, onBack, compId, onViewHeat }) {
  return (
    <div>
      <Header title="Bracket" onBack={onBack} />
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {state.rounds.map((round) => {
          const heats = state.heats.filter((h) => h.roundId === round.id);
          return (
            <div key={round.id}>
              <div style={{ marginBottom: 10 }}>
                <Pill tone={ROUND_TONES[round.toneIndex]}>{round.name}</Pill>
              </div>
              <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6 }}>
                {heats.map((h) => (
                  <BracketHeatTable key={h.id} state={state} heat={h} compId={compId} onViewHeat={onViewHeat} />
                ))}
                {heats.length === 0 && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>No heats in this round.</p>}
              </div>
            </div>
          );
        })}
        {state.rounds.length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>Nothing planned yet.</p>}
      </div>
    </div>
  );
}

function CompetitionPicker({ onOpen }) {
  const [list, setList] = useState(null);
  const [newName, setNewName] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);

  useEffect(() => {
    let stop = false;
    (async () => {
      const { list: l } = await loadIndex();
      if (!stop) setList(l);
    })();
    return () => {
      stop = true;
    };
  }, []);

  const createCompetition = async () => {
    if (!newName.trim()) return;
    const entry = { id: uid(), name: newName.trim(), createdAt: Date.now() };
    const next = [...(list || []), entry];
    setList(next);
    await saveIndex(next);
    onOpen(entry.id);
  };

  const deleteCompetition = async (id) => {
    const next = (list || []).filter((c) => c.id !== id);
    setList(next);
    await saveIndex(next);
  };

  const restoreAsNew = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setRestoreError("");
    setRestoreBusy(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bundle = JSON.parse(evt.target.result);
        if (!bundle.state) throw new Error("Missing state");
        const newId = uid();
        const entry = { id: newId, name: bundle.state.compName || "Restored competition", createdAt: Date.now() };
        const next = [...(list || []), entry];
        setList(next);
        await saveIndex(next);
        await saveState(newId, bundle.state);
        const entries = Object.entries(bundle.heatsData || {});
        for (const [heatId, data] of entries) {
          await saveHeat(newId, heatId, data);
        }
        onOpen(newId);
      } catch {
        setRestoreError("Couldn't read that file — make sure it's a backup exported from this app.");
      } finally {
        setRestoreBusy(false);
      }
    };
    reader.readAsText(file);
  };

  if (list === null) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888780)" }}>Loading…</div>;
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>Kite competition judging</h2>
      <p style={{ color: "var(--text-secondary, #5F5E5A)", marginTop: 0, marginBottom: "1.25rem", fontSize: 14 }}>
        Open a saved competition, or start a new one — men's, women's, masters, or a past year, each kept separate.
      </p>
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>New competition</SectionLabel>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="e.g. KOL 26 — Men's Division" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onEnter(createCompetition)} style={{ flex: 1 }} />
          <button style={btn(true)} onClick={createCompetition}>Create</button>
        </div>
      </Card>
      <Card style={{ marginBottom: 16 }}>
        <SectionLabel>Restore a backup</SectionLabel>
        <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
          Adds it here as its own competition, under its original name — it won't overwrite anything.
        </p>
        <input type="file" accept=".json" onChange={restoreAsNew} disabled={restoreBusy} />
        {restoreBusy && <p style={{ fontSize: 13, color: "var(--text-muted, #888780)" }}>Restoring…</p>}
        {restoreError && <p style={{ fontSize: 13, color: "var(--text-danger, #A32D2D)" }}>{restoreError}</p>}
      </Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.slice().sort((a, b) => b.createdAt - a.createdAt).map((c) => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: "0.5px solid var(--border, #D9D7CE)", borderRadius: 8 }}>
            <button onClick={() => onOpen(c.id)} style={{ ...btn(false), border: "none", background: "none", padding: 0, textAlign: "left", fontSize: 15 }}>
              {c.name}
            </button>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted, #888780)" }}>{new Date(c.createdAt).toLocaleDateString()}</span>
              <IconBtn icon="Delete" onClick={() => deleteCompetition(c.id)} label="Delete competition" />
            </div>
          </div>
        ))}
        {list.length === 0 && <p style={{ color: "var(--text-muted, #888780)" }}>No saved competitions yet.</p>}
      </div>
    </div>
  );
}

const PICKER_PASSWORD_DEFAULT = "Soulgames";

function PasswordField({ value, onChange, onKeyDown, placeholder, style }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ display: "flex", gap: 6, flex: 1, ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ flex: 1 }}
      />
      <button type="button" onClick={() => setVisible((v) => !v)} style={{ ...btn(false), fontSize: 12, padding: "8px 10px" }}>
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function PickerGate({ onOpen }) {
  const pickerKey = "kite-comp:picker-unlock";
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return localStorage.getItem(pickerKey) === PICKER_PASSWORD_DEFAULT;
    } catch {
      return false;
    }
  });
  const [pwInput, setPwInput] = useState("");
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(true);

  const tryUnlock = () => {
    if (pwInput === PICKER_PASSWORD_DEFAULT) {
      setUnlocked(true);
      setError("");
      if (remember) {
        try {
          localStorage.setItem(pickerKey, pwInput);
        } catch {}
      }
    } else {
      setError("Wrong password.");
    }
  };

  if (!unlocked) {
    return (
      <div>
        <h2 style={{ marginTop: 0, marginBottom: 12 }}>Kite competition judging</h2>
        <Card>
          <SectionLabel>Admin password required</SectionLabel>
          <p style={{ fontSize: 13, color: "var(--text-secondary, #5F5E5A)", marginTop: 0 }}>
            Creating, opening, or deleting a competition needs the admin password. If you're a judge, spotter, or
            here to watch, ask the organizer for the direct link to the specific competition instead.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <PasswordField value={pwInput} onChange={(e) => setPwInput(e.target.value)} onKeyDown={onEnter(tryUnlock)} placeholder="Admin password" />
            <button style={btn(true)} onClick={tryUnlock}>Unlock</button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary, #5F5E5A)" }}>
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember on this device
          </label>
          {error && <p style={{ color: "var(--text-danger, #A32D2D)", fontSize: 13, marginTop: 8, marginBottom: 0 }}>{error}</p>}
        </Card>
      </div>
    );
  }

  return <CompetitionPicker onOpen={onOpen} />;
}

export default function KiteCompApp() {
  const [compId, setCompId] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("comp") || null;
    } catch {
      return null;
    }
  });
  const [role, setRole] = useState(null);
  const [focusHeatId, setFocusHeatId] = useState(null);
  const [state, update, ready] = useSharedState(compId);
  const [storageOk, setStorageOk] = useState(true);

  useEffect(() => {
    const handler = (e) => setStorageOk(e.detail.ok);
    window.addEventListener("kite-comp-storage-status", handler);
    return () => window.removeEventListener("kite-comp-storage-status", handler);
  }, []);

  const openComp = (id) => {
    setCompId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("comp", id);
      window.history.replaceState({}, "", url);
    } catch {}
  };
  const switchComp = () => {
    setCompId(null);
    setRole(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("comp");
      window.history.replaceState({}, "", url);
    } catch {}
  };

  const storageBanner = !storageOk && (
    <div style={{ background: "var(--bg-danger, #FCEBEB)", color: "var(--text-danger, #A32D2D)", padding: "10px 14px", borderRadius: 10, marginBottom: 16, fontSize: 13, lineHeight: 1.4 }}>
      ⚠ Not syncing right now. This usually means the Supabase URL/key aren't set correctly for this deployment, or the database tables haven't been created yet — check the site's environment variables and that supabase-schema.sql has been run.
    </div>
  );

  if (!compId) {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "1rem 0" }}>
        {storageBanner}
        <PickerGate onOpen={openComp} />
      </div>
    );
  }

  if (!ready) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted, #888780)" }}>Loading…</div>;
  }

  const backToRoles = () => { setRole(null); setFocusHeatId(null); };
  const viewLiveHeat = (heatId) => {
    setFocusHeatId(heatId);
    setRole("leaderboard");
  };

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", padding: "1rem 0" }}>
      {storageBanner}
      {!role && (
        <div>
          <button onClick={switchComp} style={{ ...btn(false), fontSize: 12, marginBottom: 12 }}>
            ← Switch competition
          </button>
          <RoleSelect onPick={setRole} compName={state.compName} />
        </div>
      )}
      {role === "admin" && <AdminGate state={state} update={update} onBack={backToRoles} compId={compId} />}
      {role === "spotter" && <SpotterView state={state} update={update} onBack={backToRoles} compId={compId} />}
      {role === "judge" && <JudgeView state={state} update={update} onBack={backToRoles} compId={compId} />}
      {role === "leaderboard" && <LeaderboardView state={state} onBack={backToRoles} compId={compId} focusHeatId={focusHeatId} />}
      {role === "bracket" && <BracketView state={state} onBack={backToRoles} compId={compId} onViewHeat={viewLiveHeat} />}
    </div>
  );
}
