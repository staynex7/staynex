import { useEffect, useState } from "react";
import { Users, Loader2 } from "lucide-react";
import { api } from "../api/client.js";
import AmenityChips from "./AmenityChips.jsx";

const EMPTY = { interests: [], sports: [], lifestyle: [], religion: "", shareWithRoommates: false };

/**
 * Student's optional roommate profile. Nothing is shown to anyone unless
 * "share" is switched on, and even then only as anonymous filter matches —
 * other students never see a name, photo or the tags themselves.
 */
export default function RoommateProfile() {
  const [options, setOptions] = useState(null);
  const [profile, setProfile] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([api.roommateOptions(), api.getRoommateProfile()])
      .then(([opts, p]) => {
        setOptions(opts);
        setProfile({
          interests: p.interests || [],
          sports: p.sports || [],
          lifestyle: p.lifestyle || [],
          religion: p.religion || "",
          shareWithRoommates: !!p.share_with_roommates,
        });
      })
      .catch(() => setMsg("Couldn't load your roommate profile."));
  }, []);

  if (!options) return msg ? <p className="text-sm text-ink/50 mt-8">{msg}</p> : null;

  const toggle = (key) => (item) =>
    setProfile((p) => ({ ...p, [key]: p[key].includes(item) ? p[key].filter((x) => x !== item) : [...p[key], item] }));

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      await api.saveRoommateProfile(profile);
      setMsg("Saved.");
    } catch (err) {
      setMsg(err.message || "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10 border border-ink/10 rounded-xl p-5 bg-white/60" aria-labelledby="rm-heading">
      <div className="flex items-center gap-2 mb-1">
        <Users size={18} className="text-rust" />
        <h2 id="rm-heading" className="font-display text-xl text-ink">Roommate profile</h2>
      </div>
      <p className="text-sm text-ink/60 mb-5">
        Optional. Helps other students find rooms with people they'd click with. Everything is anonymous —
        nobody sees your name or your answers, only that a room has someone who matches their filter.
      </p>

      <div className="space-y-5">
        <AmenityChips label="Interests" options={options.interests} selected={profile.interests} onToggle={toggle("interests")} />
        <AmenityChips label="Sports" options={options.sports} selected={profile.sports} onToggle={toggle("sports")} />
        <AmenityChips label="Lifestyle" options={options.lifestyle} selected={profile.lifestyle} onToggle={toggle("lifestyle")} />
        <AmenityChips
          label="Religion (optional)"
          options={options.religions}
          selected={profile.religion ? [profile.religion] : []}
          onToggle={(r) => setProfile((p) => ({ ...p, religion: p.religion === r ? "" : r }))}
        />

        <label className="flex items-start gap-3 text-sm text-ink cursor-pointer">
          <input
            type="checkbox"
            checked={profile.shareWithRoommates}
            onChange={(e) => setProfile((p) => ({ ...p, shareWithRoommates: e.target.checked }))}
            className="mt-0.5 accent-rust"
          />
          <span>Let my answers count toward other students' roommate filter (off by default)</span>
        </label>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-ink text-paper rounded-full px-5 py-2 text-sm font-medium hover:bg-rust disabled:opacity-50 flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-rust"
        >
          {saving && <Loader2 size={14} className="animate-spin" />} Save profile
        </button>
        {msg && <span role="status" className="text-sm text-ink/60">{msg}</span>}
      </div>
    </section>
  );
}
